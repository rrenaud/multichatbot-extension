#!/usr/bin/env node
// End-to-end tests: real Chromium + the unpacked extension + MOCK chatbot sites.
//
//   node test/e2e.js            # all suites
//   node test/e2e.js m1         # just one suite (m0 | m1 | bridge)
//
// Requires `playwright` (npm i -D playwright && npx playwright install chromium).
// The mocks live in test/mock/. They only prove the pipeline works against the DOM
// shape we *believe* the sites have; live selectors are tracked in TODO-LIVE.md.
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");
const pages = require("./mock/pages");

const EXT = path.resolve(__dirname, "..");
const ENGINE = fs.readFileSync(path.join(__dirname, "mock", "engine.js"), "utf8");
const HOSTS = { chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com", claude: "https://claude.ai" };
const NEWCHAT = { chatgpt: "https://chatgpt.com/", gemini: "https://gemini.google.com/app", claude: "https://claude.ai/new" };

let passed = 0, failed = 0;
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    results.push(`  ok   ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    results.push(`  FAIL ${name}: ${e.message}`);
  }
  console.log(results[results.length - 1]);
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const nonce = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// Mock sites are served by a local HTTPS server; Chromium's --host-resolver-rules maps the
// real hostnames to it. (Playwright's page routing misses the first navigation of tabs the
// *extension* creates, which then leak to the real sites.)
let mockServer = null;
function startMockServer() {
  if (mockServer) return mockServer;
  const https = require("https");
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "askall-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"),
    "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=askall-mock"], { stdio: "ignore" });
  const hostToSite = Object.fromEntries(Object.entries(HOSTS).map(([s, o]) => [new URL(o).host, s]));
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (req, res) => {
    const site = hostToSite[(req.headers.host || "").split(":")[0]];
    const u = new URL(req.url, "https://x");
    if (u.pathname === "/__mock/engine.js") { res.setHeader("content-type", "application/javascript"); return res.end(ENGINE); }
    if (site && (req.headers.accept || "").includes("text/html")) { res.setHeader("content-type", "text/html"); return res.end(pages[site]); }
    res.statusCode = 404; res.end();
  });
  mockServer = new Promise((resolve) => srv.listen(0, "127.0.0.1", () => { srv.unref(); resolve(srv.address().port); }));
  return mockServer;
}

async function launch() {
  const port = await startMockServer();
  const rules = Object.values(HOSTS).map((o) => `MAP ${new URL(o).host}:443 127.0.0.1:${port}`).join(", ");
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    env,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      `--host-resolver-rules=${rules}, EXCLUDE 127.0.0.1`, "--ignore-certificate-errors"],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  return { ctx, sw, extId };
}

async function openSite(ctx, site) {
  const p = await ctx.newPage();
  await p.goto(NEWCHAT[site]);
  await p.waitForFunction(() => window.__mockReady === true || document.readyState === "complete");
  await p.waitForTimeout(300); // let document_idle content scripts load
  return p;
}

/** Call askAndWait in the tab for `site` from the service worker (the M1 "done when" check). */
function askVia(sw, site, msg) {
  return sw.evaluate(async ({ pattern, msg }) => {
    const [tab] = await chrome.tabs.query({ url: pattern });
    if (!tab) return { ok: false, error: "no tab" };
    return chrome.tabs.sendMessage(tab.id, msg);
  }, { pattern: HOSTS[site] + "/*", msg });
}

// ---------------------------------------------------------------------------
async function suiteM0({ ctx, sw }) {
  for (const site of ["chatgpt", "gemini", "claude"]) {
    await test(`m0 stock focusAndFill sends on ${site}`, async () => {
      const p = await openSite(ctx, site);
      const r = await askVia(sw, site, { action: "focusAndFill", text: "hello from stock UI" });
      assert(r && r.success, "focusAndFill failed: " + JSON.stringify(r));
      await p.waitForSelector(".user-msg", { timeout: 3000 });
      const got = await p.textContent(".user-msg");
      assert(got === "hello from stock UI", "mock received: " + JSON.stringify(got));
      await p.close();
    });
  }
}

async function suiteM1({ ctx, sw }) {
  const opened = {};
  for (const site of ["chatgpt", "gemini", "claude"]) opened[site] = await openSite(ctx, site);

  for (const site of ["chatgpt", "gemini", "claude"]) {
    await test(`m1 ping ${site}`, async () => {
      const r = await askVia(sw, site, { action: "ping" });
      assert(r.ok && r.site === site, JSON.stringify(r));
    });
    await test(`m1 exact echo ${site}`, async () => {
      const n = "PONG-" + nonce();
      const r = await askVia(sw, site, { action: "askAndWait", text: `Reply with exactly ${n}` });
      assert(r.ok, JSON.stringify(r));
      assert(r.text === n, `text=${JSON.stringify(r.text)} want ${n}`);
    });
  }

  for (const site of ["chatgpt", "gemini"]) {
    await test(`m1 long answer + code blocks not truncated (${site})`, async () => {
      const r = await askVia(sw, site, { action: "askAndWait", text: "LONG please" });
      assert(r.ok, JSON.stringify(r).slice(0, 300));
      assert(r.text.includes("END-OF-LONG"), "truncated");
      assert(r.text.includes("```python\ndef f(x):\n    return x < 2\n\nprint(f(1))\n```"), "python fence missing:\n" + r.text.slice(-900));
      assert(r.text.includes("```js\nconst a = [1, 2];"), "js fence missing");
      assert(r.text.includes("`inline()`"), "inline code");
      assert(r.text.includes("| k | v |"), "table");
      assert(r.text.includes("- beta\n   - beta-1"), "nested list:\n" + r.text.slice(r.text.indexOf("- alpha"), r.text.indexOf("- alpha") + 60));
      assert(!/Copy code|thumb_up|Show thinking/.test(r.text), "UI cruft not stripped");
      assert(r.text.includes("## Long answer"), "heading");
    });
  }

  for (const site of ["chatgpt", "gemini", "claude"]) {
    await test(`m1 multi-line prompt keeps newlines (${site})`, async () => {
      const r = await askVia(sw, site, { action: "askAndWait", text: "ECHO\nline one\nline two" });
      assert(r.ok, JSON.stringify(r));
      assert(/line one\s*\n\s*line two/.test(r.text), "got " + JSON.stringify(r.text));
    });
  }

  await test("m1 thinking phase (5 s silent, generating) waits for real answer", async () => {
    const n = "PONG-" + nonce();
    const r = await askVia(sw, "chatgpt", { action: "askAndWait", text: `THINK. Reply with exactly ${n}` });
    assert(r.ok && r.text === n, JSON.stringify(r));
    assert(r.ms > 5000, "returned too early: " + r.ms);
  });
  await test("m1 mid-stream pause > quietMs while generating is not cut off (gemini)", async () => {
    const r = await askVia(sw, "gemini", { action: "askAndWait", text: "PAUSE. Reply with exactly X1" });
    assert(r.ok && r.text.includes("AFTER-PAUSE"), JSON.stringify(r));
  });
  await test("m1 no response → no_response_started", async () => {
    const r = await askVia(sw, "claude", { action: "askAndWait", text: "NEVER", startTimeoutMs: 2000 });
    assert(!r.ok && r.error === "no_response_started" && r.stage === "start", JSON.stringify(r));
  });
  await test("m1 endless stream → timeout with partial", async () => {
    // fresh tab: the HANG answer keeps "generating" forever
    await opened.chatgpt.close();
    opened.chatgpt = await openSite(ctx, "chatgpt");
    const r = await askVia(sw, "chatgpt", { action: "askAndWait", text: "HANG", timeoutMs: 3000 });
    assert(!r.ok && r.error === "timeout" && r.partial.includes("mock answer"), JSON.stringify(r));
    await opened.chatgpt.close();
  });
  for (const p of Object.values(opened)) if (!p.isClosed()) await p.close();
}

// ---------------------------------------------------------------------------
// bridge suite: real `askall serve` + CLI ↔ extension ↔ mock sites (port 47821, fixed in bridge.js)
const PY = process.env.PYTHON || "python3";
const ASKALL = path.join(EXT, "host", "askall.py");
const os = require("os");
const ASKALL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "askall-e2e-"));

function cli(args, { stdin, env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(PY, [ASKALL, ...args], { env: { ...process.env, ASKALL_HOME, ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

async function waitConnected(extId, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await cli(["status", "--ext-id", extId]);
    if (r.code === 0) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("extension did not connect within " + ms + " ms");
}

async function suiteBridge(env) {
  const { ctx, extId } = env;
  let sw = env.sw;
  await cli(["stop"]); // in case one is left over
  const daemon = spawn(PY, [ASKALL, "serve", "--ext-id", extId], { env: { ...process.env, ASKALL_HOME }, stdio: ["ignore", "ignore", "pipe"] });
  let daemonLog = "";
  daemon.stderr.on("data", (d) => (daemonLog += d));
  try {
    await test("bridge: extension connects to daemon", async () => {
      const ms = await waitConnected(extId);
      assert(ms < 35000, "took " + ms);
    });

    await test("bridge: PONG via CLI, tabs auto-opened, < 20 s (acceptance 1, 4a)", async () => {
      // no mock tabs are open yet → bridge must create them
      const n = "PONG-" + nonce();
      const t0 = Date.now();
      const r = await cli(["ask", `Reply with exactly ${n}`, "--sites", "chatgpt,gemini", "--format", "md", "--ext-id", extId]);
      const ms = Date.now() - t0;
      assert(r.code === 0, `exit ${r.code}\n${r.stdout}\n${r.stderr}`);
      assert(r.stdout === `## chatgpt\n${n}\n\n## gemini\n${n}\n`, JSON.stringify(r.stdout));
      assert(ms < 20000, "took " + ms);
    });

    await test("bridge: JSON output, --stdin, multi-line prompt, claude too", async () => {
      const r = await cli(["ask", "--stdin", "--sites", "chatgpt,gemini,claude", "--ext-id", extId], { stdin: "ECHO\nfirst line\nsecond 'quoted' \"line\"\n" });
      assert(r.code === 0, `exit ${r.code}\n${r.stdout}\n${r.stderr}`);
      const j = JSON.parse(r.stdout);
      for (const s of ["chatgpt", "gemini", "claude"]) {
        assert(j.results[s].ok, s + " " + JSON.stringify(j.results[s]));
        assert(/first line\s*\n\s*second 'quoted' "line"/.test(j.results[s].text), s + ": " + JSON.stringify(j.results[s].text));
        assert(!("html" in j.results[s]), "html should be omitted by default");
      }
    });

    await test("bridge: --continue reuses the same conversation", async () => {
      sw = env.sw;
      const before = await sw.evaluate(() => chrome.tabs.query({ url: "https://chatgpt.com/*" }).then((t) => t.length));
      const r = await cli(["ask", "Reply with exactly AGAIN-1", "--sites", "chatgpt", "--continue", "--ext-id", extId]);
      assert(r.code === 0, r.stdout + r.stderr);
      const tabs = await sw.evaluate(() => chrome.tabs.query({ url: "https://chatgpt.com/*" }).then((t) => t.map((x) => x.id)));
      assert(tabs.length === before, "opened a new tab");
      const page = ctx.pages().find((p) => p.url().startsWith("https://chatgpt.com"));
      const count = await page.$$eval('[data-message-author-role="assistant"]', (n) => n.length);
      assert(count === 2, "expected 2 answers in the same thread, got " + count);
    });

    await test("bridge: two concurrent asks go to the right callers (acceptance 7)", async () => {
      const a = "PONG-A" + nonce(), b = "PONG-B" + nonce();
      const [ra, rb] = await Promise.all([
        cli(["ask", `Reply with exactly ${a}`, "--sites", "chatgpt,gemini", "--ext-id", extId]),
        cli(["ask", `Reply with exactly ${b}`, "--sites", "chatgpt,gemini", "--ext-id", extId]),
      ]);
      const ja = JSON.parse(ra.stdout), jb = JSON.parse(rb.stdout);
      for (const s of ["chatgpt", "gemini"]) {
        assert(ja.results[s].text === a, `A/${s}: ${JSON.stringify(ja.results[s])}`);
        assert(jb.results[s].text === b, `B/${s}: ${JSON.stringify(jb.results[s])}`);
      }
    });

    await test("bridge: partial failure → exit 2 with error + stage", async () => {
      const r = await cli(["ask", "Reply with exactly X", "--sites", "chatgpt,nosuchbot", "--ext-id", extId]);
      assert(r.code === 2, "exit " + r.code);
      const j = JSON.parse(r.stdout);
      assert(j.results.chatgpt.ok && j.results.nosuchbot.error === "unknown_site", r.stdout);
    });

    await test("bridge: web page origin is rejected (acceptance 6)", async () => {
      const page = ctx.pages().find((p) => p.url().startsWith("https://gemini.google.com"));
      const outcome = await page.evaluate(() => new Promise((res) => {
        const w = new WebSocket("ws://127.0.0.1:47821");
        w.onopen = () => res("open");
        w.onerror = () => res("error");
        setTimeout(() => res("timeout"), 5000);
      }));
      // Either Chrome's Private Network Access blocks it, or the daemon's Origin check
      // rejects it (that path is unit-tested directly in host/tests).
      assert(outcome !== "open", outcome);
    });

    await test("bridge: doctor passes", async () => {
      const r = await cli(["doctor", "--sites", "chatgpt,gemini,claude", "--ext-id", extId]);
      assert(r.code === 0, r.stdout + r.stderr);
      assert((r.stdout.match(/ ok /g) || []).length === 3, r.stdout);
    });

    await test("bridge: tab left over from extension reload gets re-injected (acceptance 4b)", async () => {
      // Reload the extension the way you would at chrome://extensions. Tabs that were already
      // open keep an orphaned content script that no longer answers.
      const pagesBefore = ctx.pages().filter((p) => p.url().startsWith("https://chatgpt.com")).length;
      const ext = await ctx.newPage();
      await ext.goto("chrome://extensions");
      await ext.evaluate(async (id) => {
        await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
        await chrome.developerPrivate.reload(id, { failQuietly: true });
      }, extId);
      await ext.close();
      let sw2 = null;
      for (let i = 0; i < 60 && !sw2; i++) {
        await new Promise((r) => setTimeout(r, 250));
        sw2 = ctx.serviceWorkers().find((w) => w !== sw && w.url().includes(extId)) || null;
      }
      assert(sw2, "extension did not come back after reload");
      env.sw = sw = sw2;
      const pingBefore = await sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
        return chrome.tabs.sendMessage(t.id, { action: "ping" }).then(() => "answered", () => "orphaned");
      });
      assert(pingBefore === "orphaned", "precondition: old tab should not answer, got " + pingBefore);
      await waitConnected(extId);
      const r = await cli(["ask", "Reply with exactly REINJECT-OK", "--sites", "chatgpt", "--continue", "--ext-id", extId]);
      assert(r.code === 0, r.stdout + r.stderr);
      assert(JSON.parse(r.stdout).results.chatgpt.text === "REINJECT-OK", r.stdout);
      const pagesAfter = ctx.pages().filter((p) => p.url().startsWith("https://chatgpt.com")).length;
      assert(pagesAfter === pagesBefore, "should have reused the old tab, not opened a new one");
    });

    await test("bridge: daemon killed → CLI auto-spawns it, extension reconnects (acceptance 5)", async () => {
      daemon.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 500));
      const t0 = Date.now();
      const r = await cli(["ask", "Reply with exactly RESPAWN-OK", "--sites", "gemini", "--ext-id", extId]);
      assert(r.code === 0, r.stdout + r.stderr);
      assert(/started daemon/.test(r.stderr), "no auto-spawn message: " + r.stderr);
      assert(JSON.parse(r.stdout).results.gemini.text === "RESPAWN-OK", r.stdout);
      assert(Date.now() - t0 < 40000, "took " + (Date.now() - t0));
    });
  } finally {
    daemon.kill("SIGKILL");
    await cli(["stop"]);
  }
}

// ---------------------------------------------------------------------------
const SUITES = { m0: suiteM0, m1: suiteM1, bridge: suiteBridge };
module.exports = { SUITES, launch, openSite, askVia, test, assert, nonce, HOSTS, NEWCHAT, EXT };

async function main() {
  const which = process.argv.slice(2);
  const names = which.length ? which : Object.keys(SUITES);
  for (const name of names) {
    const env = await launch();
    try { await SUITES[name](env); } finally { await env.ctx.close(); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
