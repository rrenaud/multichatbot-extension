# askall: setup & usage

Ask your logged-in ChatGPT / Gemini (/ Claude) browser tabs from the command line, and from
Claude Code via `/askall`. Design: [IMPLEMENTATION.md](IMPLEMENTATION.md). Things still to
verify on the live sites: [TODO-LIVE.md](TODO-LIVE.md).

## 1. Load the extension (unpacked)

1. `chrome://extensions` → turn on **Developer mode** (top right).
2. **Load unpacked** → pick this repo's root folder (the one with `manifest.json`).
3. Check the ID shown on the card: **`memcomanbbccgomhdecjgcnhihgiaepb`**. It's pinned by the
   `"key"` in `manifest.json`, so it stays the same across machines and reloads. If yours
   differs, export `ASKALL_EXT_ID=<id>` wherever you run `askall`.
4. After editing any extension file, click the reload icon on the card. Tabs that were already
   open get the new content script re-injected automatically on the next `askall ask`.

Log in to chatgpt.com and gemini.google.com in that Chrome profile. Open tabs are optional:
askall opens missing ones in the background.

## 2. Install the CLI

```bash
pipx install -e host/
```
(or `pip install 'websockets>=13'` and `ln -s "$PWD/host/askall.py" ~/bin/askall`).
Needs Python ≥ 3.9 and websockets ≥ 13 (the guide said ≥ 12; askall uses the newer
`websockets.asyncio` API).

## 3. Run

```bash
askall serve            # optional: `askall ask` auto-starts it in the background (log: ~/.askall/serve.log)
```
```bash
askall status           # daemon up? extension connected? (the extension reconnects within ~5–30 s)
```
```bash
askall doctor           # PONG test on chatgpt+gemini; says which stage failed: setup/fill/send/start/complete
```
```bash
askall ask "Reply with exactly PONG-$RANDOM" --format md
```

`askall ask` options: `--sites chatgpt,gemini,claude` (default `$ASKALL_SITES` or
`chatgpt,gemini,claude`), `--continue` (follow up in the same conversations), `--timeout 600`
(seconds, per site), `--format json|md`, `--stdin`, `--activate` (focus each tab before
sending, for sites that stall in background tabs), `--html`, `--no-spawn`, `-v` (progress
on stderr). Exit code: 0 all ok, 2 some failed, 1 none.

`askall stop` stops the daemon. Use `--port` / `$ASKALL_PORT` for a different port, but note
the extension side is fixed to 47821 (`PORT` in `src/bridge.js`).

## 3b. In the browser

Type `ask` + <kbd>Space</kbd> in Chrome's address bar, then your question, then <kbd>Enter</kbd>.
That opens `src/askall/ask.html`: answers side by side, streaming as they're written, with a
follow-up box (same conversations) and **New chat**. Pick sites with the chips at the top.
It runs jobs inside the extension, so it works without the daemon.

`askall reload` reloads the unpacked extension after you edit its files (no trip to
chrome://extensions). The daemon runs as a systemd user service: `~/.config/systemd/user/askall.service`.

## 4. Claude Code

`.claude/commands/askall.md` and `askall-continue.md` work inside this repo. To use them
everywhere:
```bash
mkdir -p ~/.claude/commands && ln -s "$PWD/.claude/commands/askall.md" "$PWD/.claude/commands/askall-continue.md" ~/.claude/commands/
```
and add `"Bash(askall ask:*)"` to `permissions.allow` in `~/.claude/settings.json` (this repo's
`.claude/settings.json` already allows it for this project). Then run `/askall <question>`.

## 5. Where things are

| file | what |
|---|---|
| `src/scrapers.js` | **all askall selectors** (`SITES`), completion detection, HTML→markdown |
| `src/content.js` | site handlers (fill + send), `ping` / `askAndWait` / `askall-tick` actions |
| `src/bridge.js` | service-worker WebSocket client, job runner, tab management, re-injection, `ask` omnibox keyword |
| `src/askall/` | the in-browser ask page (`ask.html`/`.js`/`.css`, vendored `marked`) |
| `host/askall.py` | `serve` / `ask` / `status` / `doctor` / `stop` |
| `test/e2e.js` + `test/mock/` | Playwright e2e: real Chromium + extension + daemon + CLI against **mock** sites |
| `host/tests/` | daemon/CLI unit tests with a fake extension |

## 6. Tests

```bash
npm install          # just playwright; then `npx playwright install chromium` if you don't have one
npm test             # e2e (m0, m1, bridge suites) + python tests
node test/e2e.js m1  # one suite
```
The e2e suite serves mock sites from a local HTTPS server and maps the real hostnames to it
with `--host-resolver-rules`, so it never touches the real sites. Port 47821 must be free.

## 7. Differences from IMPLEMENTATION.md

- Selectors for input/send of chatgpt/gemini/claude moved from `content.js` into
  `src/scrapers.js` too, so there's one place to edit. `scrapers.js` is also imported by the
  service worker (for tab URL patterns / new-chat URLs).
- Rich-text composers are filled by synthetic paste → `execCommand` → `textContent`
  (the original only did `textContent`, which flattens multi-line prompts).
- The "generating" signal only counts *rendered* elements (`getClientRects()`), so a
  hidden stop button doesn't block completion.
- `text` is markdown from a small built-in converter (fences with language, lists,
  tables, KaTeX source) instead of `innerText`; turndown wasn't needed.
- The bridge "ticks" waiting content scripts every 2 s via extension messages, because
  timers in hidden tabs are throttled (up to 1/min) and messages are not.
- The bridge serializes prompts per site, remembers the tab used per site (so `--continue`
  hits the same conversation), retries the WS every 5 s while alive, and buffers results
  across a reconnect.
- Extra CLI commands: `status`, `doctor`, `stop`; extra flags `--activate`, `--html`,
  `--no-spawn`, `-v`.
- `DEVMODE` is on in both `content.js` and `debug.js` (console logging everywhere).
