# askall: MultiChatbot fork + local bridge + Claude Code driver

Goal: from Claude Code, run `askall ask "prompt"`. Your logged-in ChatGPT and Gemini
tabs (optionally claude.ai) receive the prompt in parallel. When every answer has
finished, their text comes back as JSON. Claude Code adds its own answer and
synthesizes all of them. No API keys are used; everything runs through the web UIs.

Base repo: https://github.com/chern-kp/multichatbot-extension
(MV3, plain JS, no bundler, last commit 2025-07, so expect stale selectors).

---

## 1. Architecture

```
Claude Code ──bash──▶ askall ask "…"          (Python CLI, WS client, no Origin header)
                         │
                         ▼
                 askall serve  ws://127.0.0.1:47821   (Python daemon, routes by id)
                         ▲
                         │ WebSocket (Origin: chrome-extension://<EXT_ID>)
                         │
   Extension service worker (src/bridge.js)
        │  chrome.tabs.sendMessage({action:"askAndWait", …})   (one per site, in parallel)
        ▼
   content.js in chatgpt.com / gemini.google.com / claude.ai tabs
        fill + send (existing handlers) → wait for completion → scrape → return text
```

Why a daemon? The MV3 service worker can only be a WS *client*, and it reconnects on a
timer. A long-lived server means the extension is already connected when the CLI
runs, so you don't wait on a reconnect.

### Security model (no token needed)
Browsers always send an `Origin` header on WebSocket handshakes, and web pages cannot
forge it. The daemon accepts only these two kinds of connection:
- `Origin == chrome-extension://<EXT_ID>` → role = extension
- no `Origin` header at all → role = CLI (a local process; local processes are trusted)
- anything else → reject (this stops random websites from driving your accounts)

Bind to `127.0.0.1` only. Pin the extension ID by adding a `"key"` to the manifest, or
pass it through the `ASKALL_EXT_ID` env var.

---

## 2. Repo layout after the change

```
manifest.json            + "alarms", "scripting" permissions; scrapers.js in content_scripts
src/background.js        + `import "./bridge.js";` at top (already "type": "module")
src/bridge.js            NEW – WS client, job runner
src/scrapers.js          NEW – per-site response selectors + waitForResponse()
src/content.js           + "ping" and "askAndWait" actions
host/askall.py           NEW – `serve` and `ask` subcommands
host/requirements.txt    websockets>=12
.claude/commands/askall.md   NEW – Claude Code slash command
```

---

## 3. Milestones (do them in order and test each one)

### M0: Fork, load, and fix sending
1. Fork, clone, then `chrome://extensions` → Developer mode → Load unpacked.
2. Set `DEVMODE = true` in `src/content.js` (otherwise every console call is silenced).
3. Use the existing UI to send a prompt to ChatGPT and Gemini tabs. Fix any broken
   selectors in `handleChatGPT` / `handleGemini` / `handleClaude`. Gemini currently has
   **no send-button selector** and relies on an Enter fallback. Add one if Enter is flaky.
4. Use `claude --chrome` to inspect the live DOM and find selectors quickly.

**Done when:** the stock UI reliably sends to ChatGPT and Gemini.

### M1: Response scraping (`src/scrapers.js` + `askAndWait`)
Add `src/scrapers.js` to `content_scripts.js` **before** `content.js`. Content scripts
listed together share one isolated world, so expose the code as a global:
`window.__mcbScrapers`.

Per-site config. **These selectors are starting points; verify each one on the live
site:**

| site | assistant message nodes | "still generating" signal | new-chat URL |
|---|---|---|---|
| chatgpt.com | `[data-message-author-role="assistant"]` | `button[data-testid="stop-button"]` present | `https://chatgpt.com/` |
| gemini.google.com | `model-response` (text in `message-content`) | `button[aria-label*="Stop" i]` present | `https://gemini.google.com/app` |
| claude.ai | `.font-claude-response` / `[data-is-streaming]` | `[data-is-streaming="true"]` present | `https://claude.ai/new` |

Completion detection. Be redundant, because selectors drift:
```
baseline = count(assistantNodes)                  // BEFORE sending
send()                                            // existing site handler
wait until count(assistantNodes) > baseline       // timeout: 60 s → error "no_response_started"
then wait until ALL of:
   - generating signal absent
   - last node's innerText unchanged for QUIET_MS (default 2000)
   - text non-empty
hard timeout: request.timeoutMs (default 600_000; thinking models are slow)
```
Implement the waiting with a `MutationObserver` on `document.body`, with
`subtree, childList, characterData`. Each mutation resets the quiet deadline. Add a
500 ms poll only as a backstop. **Reason:** hidden tabs throttle timers to 1 per second,
and after 5 minutes Chrome's *intensive throttling* drops chained timers to once per
minute. Mutation callbacks still fire.

Returned shape:
```js
{ ok: true, text, html, url: location.href, ms }            // success
{ ok: false, error: "timeout" | "no_response_started" | "send_failed" | <msg>, partial }
```
- `text`: start with `innerText` of the last assistant node. v2: vendor `turndown.js`
  into `src/vendor/` and add it to `content_scripts` to get real markdown (code fences
  survive).
- Strip UI cruft inside the node (copy buttons, "Show thinking" headers) with a
  per-site `stripSelectors` list.

In `content.js`, add the following to the `onMessage` listener:
- `{action:"ping"}` → `sendResponse({ok:true, site})`. Used to check that the script is loaded.
- `{action:"askAndWait", text, timeoutMs}` → baseline → existing handler(text) →
  `waitForResponse` → `sendResponse(result)`; `return true` (async).

**Testing without the bridge:** from the service worker's DevTools console, run
`chrome.tabs.sendMessage(<tabId>, {action:"askAndWait", text:"Reply with exactly PONG-123"})`.

**Done when:** short replies, long replies with code blocks, and a thinking-mode reply
all come back complete and not truncated mid-stream.

### M2: The bridge (`src/bridge.js`)
```js
const URL_ = "ws://127.0.0.1:47821/ext";
let ws;
function connect() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(URL_);
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => { ws = null; };
}
// keep the SW alive: Chrome 116+ extends SW lifetime while WS traffic flows (<30 s gaps)
setInterval(() => ws?.readyState === 1 && ws.send('{"type":"ping"}'), 20_000);
chrome.alarms.create("askall-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === "askall-reconnect" && connect());
connect();
```
Job handling for `{type:"ask", id, prompt, sites:[…], newChat:true, timeoutMs}`:
1. For each site, in parallel (`Promise.allSettled`):
   - Find a tab: `chrome.tabs.query({url: "https://chatgpt.com/*"})`. If there is none,
     `chrome.tabs.create({url: newChatUrl, active:false})`.
   - If `newChat`, use `chrome.tabs.update(tabId, {url: newChatUrl})` and wait for
     `tabs.onUpdated` status `complete`.
   - Ping the content script. If that fails (for example, after an extension reload,
     old tabs lack the new script), use `chrome.scripting.executeScript({target:{tabId},
     files:["src/scrapers.js","src/content.js"]})`, wait 500 ms, and ping again.
   - `chrome.tabs.sendMessage(tabId, {action:"askAndWait", text: prompt, timeoutMs})`.
2. Send back `{type:"result", id, results:{chatgpt:{…}, gemini:{…}}}`.
3. Optionally stream `{type:"progress", id, site, state:"sent"|"generating"|"done"}`.

Manifest: add `"alarms", "scripting"` to `permissions`. WebSocket to 127.0.0.1 needs no
host permission. If CSP blocks it, add `connect-src 'self' ws://127.0.0.1:47821` to
`extension_pages`.

**Gotcha:** some sites behave oddly when the tab is never activated. If a site stalls,
put each bot in its own (non-minimized) window, or briefly activate the tab before
sending.

### M3: Daemon + CLI (`host/askall.py`)
One file, `asyncio` + `websockets`.

`askall serve [--port 47821] [--ext-id ID]`
- In `process_request`, check Origin as described in §1.
- Keep one extension connection (the newest wins). CLI connections send `ask` jobs.
  Assign a `uuid` and forward the job to the extension. Route the `result` / `progress`
  messages that come back to the CLI connection that sent the job.
- If no extension is connected, wait up to 35 s (one reconnect alarm cycle) before
  returning `{"error":"extension_not_connected"}`.

`askall ask "prompt" [--sites chatgpt,gemini] [--continue] [--timeout 600]
[--format json|md] [--stdin]`
- If no daemon answers on the port, auto-spawn `askall serve` detached and retry.
- `--continue` means `newChat:false` (a follow-up in the same conversations).
- `--stdin` reads the prompt from stdin, so long prompts avoid shell-quoting problems.
- `--format md` prints `## chatgpt\n<text>\n\n## gemini\n<text>`.
- Exit code 0 if every site succeeded, 2 if some failed, 1 if none did.

Install with `pipx install -e host/` (add a minimal `pyproject.toml` with a console
script), or just `ln -s …/askall.py ~/bin/askall`.

Optional: a launchd/systemd user unit for `askall serve`. Auto-spawn usually makes it
unnecessary.

**Done when:** `askall ask "Reply with exactly PONG-$RANDOM" --format md` returns both
PONGs in under 20 s.

### M4: Claude Code driver (`.claude/commands/askall.md`)
```markdown
---
description: Ask ChatGPT + Gemini (via browser) and synthesize with your own answer
argument-hint: <question>
allowed-tools: Bash(askall ask:*)
---
Question: $ARGUMENTS

1. FIRST, write your own complete answer to the question, before you see anything
   else, so the other models don't anchor you. Keep it in a section titled "Claude (independent)".
2. Run: `askall ask --stdin --format json` with the question on stdin.
   Use a Bash timeout of 600000 ms.
3. Synthesize:
   - **Consensus**: what all models agree on.
   - **Disagreements**: each point of divergence. Say who is right and why. Verify
     with code or search when it's checkable.
   - **Unique contributions**: useful points only one model raised.
   - **Final answer**: the best combined answer.
   Name the source model for each claim you keep. If a site returned an error,
   say so and continue with the rest.
```
Then add `"Bash(askall ask:*)"` to `permissions.allow` in `~/.claude/settings.json`
so it runs without prompting.

Variants worth adding later: `/askall-continue` (passes `--continue` for follow-ups), and
a "debate" mode where each model gets the others' answers for one critique round
(this is just a second `askall ask --continue` with the other answers pasted in).

---

## 4. Acceptance tests
1. Exact-echo test on each site (`Reply with exactly PONG-<nonce>`) matches.
2. A long answer (~1500 words plus 2 code blocks) is not truncated, and code survives.
3. ChatGPT in a thinking/reasoning mode with a >2-minute answer returns complete.
4. A missing tab gets auto-opened. A tab left over from before an extension reload gets
   re-injected.
5. Kill the daemon and run `askall ask`: the daemon auto-spawns, and the extension
   reconnects within 35 s.
6. A web page at any origin running `new WebSocket("ws://127.0.0.1:47821")` is rejected.
7. Two concurrent `askall ask` calls return to the right callers. (If the content
   scripts can't handle two prompts at once, serialize jobs per site in the bridge.)

## 5. Known fragility / maintenance
- Selectors **will** break when the sites ship UI changes. Keep all selectors in
  `scrapers.js` plus the existing handlers, and keep a `askall doctor` subcommand that
  runs the PONG test per site and reports which step failed (fill / send / start /
  complete).
- Automating the consumer web UIs is a ToS gray area. Keep the volume personal-scale.
- Don't send anything to these sites that you wouldn't type into them by hand.
  Everything goes into your chat history there (ChatGPT temporary chats are an option
  if you want to avoid that).
