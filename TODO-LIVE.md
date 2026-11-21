# TODO-LIVE: things to verify against the real sites

Everything here was built and tested against **mock** pages (`test/mock/`) that imitate
what we *believe* the ChatGPT / Gemini / Claude DOM looks like. None of it has touched the
live sites yet. Work through this list locally with `claude --chrome` (or DevTools) on
logged-in tabs.

**All askall selectors live in one place: `src/scrapers.js` → `SITES`.** Each entry is an
ordered list, and the first match wins. Edit there, reload the extension at `chrome://extensions`,
then reload the chat tabs.

Quick per-site console check (page DevTools → pick the extension's content-script
context in the console's context dropdown, "MultiChatbot"):
```js
S = __mcbScrapers; k = S.siteKeyForHost(location.hostname)
S.qsFirst(S.SITES[k].input)          // composer element?
S.qsFirst(S.SITES[k].send)           // send button? (type something first; it may be disabled when empty)
S.snapshot(k)                        // assistant-node counts per selector, should equal # of answers
S.isGenerating(k)                    // true only while an answer streams
S.extract(k, S.newestNode(k, S.SITES[k].assistant.map(()=>0))).text   // last answer as markdown
```

## M0: sending
- [ ] ChatGPT `input`: `div#prompt-textarea[contenteditable="true"]` still the composer?
- [ ] ChatGPT `send`: `button[data-testid="send-button"]` (or `#composer-submit-button`)?
- [ ] Gemini `input`: `rich-textarea .ql-editor` still the composer?
- [ ] Gemini `send` (**new, pure guess**): `button.send-button` / `button[aria-label="Send message"]`.
      If none match, the Enter fallback is used, which may or may not work.
- [ ] Claude `input`/`send`: the ProseMirror div / `button[aria-label="Send message"]`.
- [ ] **Multi-line fill**: content.js now fills rich editors by a synthetic `paste` event first,
      then `execCommand('insertText')`, then the old `textContent`. Send `ECHO\nline one\nline two`
      (with real newlines) and check the site receives 3 lines, not one, and the send
      button enables. (The stock MultiChatbot UI uses the same code path.)

## M1: response scraping / completion
- [ ] ChatGPT `assistant`: `[data-message-author-role="assistant"]`. With reasoning models, check
      whether one turn produces several such nodes. We take the *last new* one.
- [ ] ChatGPT `content`: `.markdown` inside the node. `strip`: buttons/svg.
- [ ] ChatGPT `generating`: `button[data-testid="stop-button"]` visible only while streaming
      **and while thinking**. This matters most: if no signal is present while it thinks,
      completion relies on "text non-empty + 2 s quiet", and a visible "Thinking…" label
      inside `.markdown` could end it early.
- [ ] Gemini `assistant`: `model-response`; `content`: `message-content .markdown`.
- [ ] Gemini `generating`: `button[aria-label*="Stop" i]` (rendered only while generating?).
      Hidden matches are ignored (we check `getClientRects()`), but any *visible* button whose
      label contains "Stop" would keep it waiting until timeout.
- [ ] Gemini `strip`: confirm "Show thinking" lives in `model-thoughts` **outside** `message-content`.
- [ ] Claude `assistant`: `.font-claude-response` vs `[data-is-streaming]`; `generating`:
      `[data-is-streaming="true"]`.
- [ ] Code blocks: check the markdown has proper ```` ```lang ```` fences. The language comes from
      `code.className` `language-xxx`, which some sites don't set. Header labels ("python",
      "Copy code") should be gone.
- [ ] Math (KaTeX) renders as `$...$` (uses the `annotation[encoding="application/x-tex"]`).
- [ ] **Background tabs**: run with the chat tabs *not* focused. If a site only renders
      the stream when visible (rAF-driven), use `askall ask --activate` (the bridge briefly
      activates each tab before sending) or give each bot its own non-minimized window.

## M2/M3: bridge + daemon (tested here against mocks; verify in your browser)
- [ ] Load the unpacked extension. Its ID must be `memcomanbbccgomhdecjgcnhihgiaepb`
      (pinned by `"key"` in manifest.json). If it differs, run with `ASKALL_EXT_ID=<id>`.
- [ ] `askall status` shows `extension_connected: true` within ~30 s of `askall serve` starting.
- [ ] `askall doctor` passes for chatgpt and gemini (and claude if you use it).
- [ ] Acceptance tests 1–7 in IMPLEMENTATION.md §4 against the real sites.

## Not covered by the mock tests (verify in real Chrome)
- [ ] **Long jobs and SW lifetime**: a >5 min thinking answer (acceptance test 3). The SW stays alive
      through the 20 s WS pings and the 2 s tab ticks. Confirm the result still arrives, and if the
      WS drops mid-job, that the buffered result is flushed after the reconnect.
- [ ] **Hidden/background tabs**: the headless tests' pages are never throttled. Leave the tabs in
      the background for >5 min before asking (intensive throttling) and check completion is detected
      promptly (the 2 s ticks from the SW should cover it).
- [ ] **`--activate` with several sites in one window**: tabs get activated one after another, so only
      the last stays focused. If a site needs to stay visible while streaming, give each bot its own window.
- [ ] **Login walls / Cloudflare / "new model" interstitials**: these show up as `input_not_found`
      (stage `fill`) or `content_script_unavailable` (stage `setup`).
- [ ] **Stock MultiChatbot popup UI** still sends normally (the e2e tests only call the same
      `focusAndFill` message the popup uses, not the popup itself).
- [ ] **New chat per ask** (default): the bridge navigates the remembered tab to the new-chat URL. If you
      were reading a conversation in that tab, it gets navigated away (use a dedicated tab/window).
- [ ] The extension's errors page may list "WebSocket connection failed" while the daemon isn't
      running. That's expected noise from the reconnect loop.
