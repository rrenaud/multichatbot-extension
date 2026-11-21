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

async function launch() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  for (const [site, origin] of Object.entries(HOSTS)) {
    await ctx.route(origin + "/**", (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/__mock/engine.js") return route.fulfill({ contentType: "application/javascript", body: ENGINE });
      if (route.request().resourceType() === "document") return route.fulfill({ contentType: "text/html", body: pages[site] });
      return route.fulfill({ status: 404, body: "" });
    });
  }
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
const SUITES = { m0: suiteM0, m1: suiteM1 };
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
