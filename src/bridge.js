/**
 * @file bridge.js
 * askall: WebSocket client to the local `askall serve` daemon + job runner.
 * Imported by background.js (module service worker).
 *
 * Protocol (JSON over ws://127.0.0.1:47821/ext):
 *   daemon → ext  {type:"ask", id, prompt, sites:[...], newChat:true, timeoutMs, activate}
 *   ext → daemon  {type:"hello", role:"extension", version, sites}
 *                 {type:"progress", id, site, state}      state: tab|sent|generating|done
 *                 {type:"result", id, results:{<site>: {ok, text, html, url, ms} | {ok:false, error, stage, partial}}}
 *                 {type:"ping"}
 */
import "./scrapers.js";

const S = globalThis.__mcbScrapers;
const PORT = 47821;
const WS_URL = `ws://127.0.0.1:${PORT}/ext`;
const LOG = "[askall bridge]";

let ws = null;
const inflight = new Map(); // reqId -> { id, site, tabId }
const siteQueues = {}; // site -> promise chain (one prompt at a time per site)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SECTION - connection
const outbox = []; // results produced while disconnected; flushed on reconnect

function send(obj, { buffer = false } = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
    }
    if (buffer) outbox.push(obj);
    return false;
}

function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return; // CONNECTING or OPEN
    try {
        ws = new WebSocket(WS_URL);
    } catch (e) {
        ws = null;
        return;
    }
    const sock = ws;
    sock.onopen = () => {
        console.log(LOG, "connected");
        send({ type: "hello", role: "extension", version: chrome.runtime.getManifest().version, sites: Object.keys(S.SITES) });
        while (outbox.length && send(outbox[0])) outbox.shift();
    };
    sock.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        handle(msg);
    };
    sock.onclose = () => { if (ws === sock) ws = null; };
    sock.onerror = () => { /* onclose follows; the daemon is probably just not running */ };
}

// Keep the SW alive while connected (Chrome 116+: WS traffic within 30 s resets the idle
// timer) and retry quickly while we're alive anyway. The alarm covers SW restarts.
setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) send({ type: "ping" });
    else connect();
}, 20000);
setInterval(() => { if (!ws) connect(); }, 5000);
chrome.alarms.create("askall-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "askall-reconnect") connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
//!SECTION

// Progress events from content scripts → daemon
chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "askall-progress" && inflight.has(msg.reqId)) {
        const { id, site } = inflight.get(msg.reqId);
        send({ type: "progress", id, site, state: msg.state });
    }
    return false;
});

// Timers inside hidden tabs get throttled (down to 1/min after 5 min hidden); extension
// messages are not. While jobs run, nudge the waiting content scripts every 2 s.
setInterval(() => {
    for (const { tabId } of inflight.values()) {
        chrome.tabs.sendMessage(tabId, { action: "askall-tick" }).catch(() => {});
    }
}, 2000);

function handle(msg) {
    if (msg.type === "ask") {
        runJob(msg).catch((e) => {
            console.error(LOG, "job crashed", e);
            send({ type: "result", id: msg.id, error: "bridge_error: " + (e && e.message) }, { buffer: true });
        });
    }
}

// SECTION - jobs
async function runJob(job) {
    const { id, prompt } = job;
    const sites = job.sites && job.sites.length ? job.sites : ["chatgpt", "gemini"];
    const opts = {
        newChat: job.newChat !== false,
        timeoutMs: job.timeoutMs || S.DEFAULTS.timeoutMs,
        activate: !!job.activate,
    };
    console.log(LOG, "job", id, sites, opts);

    const settled = await Promise.allSettled(
        sites.map((site) => enqueue(site, () => runSite(id, site, prompt, opts)))
    );
    const results = {};
    sites.forEach((site, i) => {
        const s = settled[i];
        results[site] = s.status === "fulfilled"
            ? s.value
            : { ok: false, error: "bridge_error", detail: String((s.reason && s.reason.message) || s.reason), stage: "bridge", partial: "" };
    });
    send({ type: "result", id, results }, { buffer: true });
}

/** Serialize work per site: a content script handles one prompt at a time. */
function enqueue(site, fn) {
    const prev = siteQueues[site] || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    siteQueues[site] = next.catch(() => {});
    return next;
}

async function runSite(id, site, prompt, opts) {
    const cfg = S.SITES[site];
    const fail = (error, stage, extra = {}) => ({ ok: false, error, stage, partial: "", ...extra });
    if (!cfg) return fail("unknown_site", "setup", { detail: `known: ${Object.keys(S.SITES).join(", ")}` });

    // 1. find or open a tab
    let tab = await findTab(site, cfg);
    if (!tab) {
        const loaded = waitForLoad(null);
        tab = await chrome.tabs.create({ url: cfg.newChatUrl, active: false });
        await loaded.forTab(tab.id);
    } else if (opts.newChat) {
        const loaded = waitForLoad(tab.id);
        await chrome.tabs.update(tab.id, { url: cfg.newChatUrl });
        await loaded.forTab(tab.id);
    } else if (tab.discarded || tab.status !== "complete") {
        const loaded = waitForLoad(tab.id);
        if (tab.discarded) await chrome.tabs.reload(tab.id);
        await loaded.forTab(tab.id);
    }
    await rememberTab(site, tab.id);
    send({ type: "progress", id, site, state: "tab" });

    // 2. make sure our content script is there (re-inject into tabs from before a reload)
    if (!(await ensureContentScript(tab.id))) {
        const cur = await chrome.tabs.get(tab.id).catch(() => tab);
        return fail("content_script_unavailable", "setup", {
            url: cur.url || cur.pendingUrl || "",
            detail: "tab did not answer and re-injection failed (error page? login wall? captcha?)",
        });
    }

    if (opts.activate) {
        await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
        await sleep(800);
    }

    // 3. ask and wait
    const reqId = `${id}:${site}`;
    inflight.set(reqId, { id, site, tabId: tab.id });
    try {
        const guard = sleep(opts.timeoutMs + 90000).then(() => fail("timeout", "bridge"));
        const r = await Promise.race([
            chrome.tabs.sendMessage(tab.id, { action: "askAndWait", text: prompt, timeoutMs: opts.timeoutMs, reqId }),
            guard,
        ]);
        send({ type: "progress", id, site, state: "done" });
        return r || fail("no_response_from_tab", "bridge");
    } catch (e) {
        // e.g. tab closed or did a full navigation mid-answer
        return fail("tab_message_failed", "bridge", { detail: e.message });
    } finally {
        inflight.delete(reqId);
    }
}

/** Prefer the tab we used last time for this site (matters for --continue), else the most recently used one. */
async function findTab(site, cfg) {
    const tabs = await chrome.tabs.query({ url: cfg.tabUrlPatterns });
    if (!tabs.length) return null;
    const remembered = (await chrome.storage.session.get("askallTabs")).askallTabs || {};
    const prev = tabs.find((t) => t.id === remembered[site]);
    if (prev) return prev;
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0];
}

async function rememberTab(site, tabId) {
    const cur = (await chrome.storage.session.get("askallTabs")).askallTabs || {};
    cur[site] = tabId;
    await chrome.storage.session.set({ askallTabs: cur });
}

/**
 * Start listening for a load *before* triggering navigation, so a fast "complete" isn't
 * missed and a stale "complete" from before the navigation isn't mistaken for it.
 * Usage: const l = waitForLoad(tabId|null); <navigate>; await l.forTab(tabId)
 */
function waitForLoad(knownTabId, timeoutMs = 45000) {
    const seen = new Map(); // tabId -> "loading" | "complete"
    const waiters = new Map();
    const listener = (tabId, info) => {
        if (knownTabId !== null && tabId !== knownTabId) return;
        if (info.status === "loading") seen.set(tabId, "loading");
        if (info.status === "complete" && seen.get(tabId) === "loading") {
            seen.set(tabId, "complete");
            const w = waiters.get(tabId);
            if (w) w();
        }
    };
    chrome.tabs.onUpdated.addListener(listener);
    return {
        forTab(tabId) {
            return new Promise((resolve) => {
                const done = () => {
                    chrome.tabs.onUpdated.removeListener(listener);
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(done, timeoutMs); // proceed anyway; the ping decides
                if (seen.get(tabId) === "complete") return done();
                waiters.set(tabId, done);
            });
        },
    };
}

async function ping(tabId) {
    try {
        const r = await chrome.tabs.sendMessage(tabId, { action: "ping" });
        return !!(r && r.ok);
    } catch (_) {
        return false;
    }
}

async function ensureContentScript(tabId) {
    // after a fresh load the manifest content scripts run at document_idle: give them a moment
    for (let i = 0; i < 8; i++) {
        if (await ping(tabId)) return true;
        await sleep(500);
    }
    // Tabs opened before an extension reload have an orphaned script; inject fresh.
    try {
        // clear the old "already loaded" guard so content.js initializes again
        await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__contentScriptLoaded = false; } });
        await chrome.scripting.executeScript({ target: { tabId }, files: ["src/scrapers.js", "src/content.js"] });
    } catch (e) {
        console.warn(LOG, "inject failed", e);
        return false;
    }
    await sleep(500);
    return ping(tabId);
}
//!SECTION
