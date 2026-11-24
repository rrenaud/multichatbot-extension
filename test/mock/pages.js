// HTML shells for the mock sites. Each mimics the selectors in src/scrapers.js.
const shell = (site, composer) => `<!doctype html><html data-site="${site}"><head><meta charset="utf-8"><title>mock ${site}</title></head>
<body><main><div id="thread"></div>${composer}</main><script src="/__mock/engine.js"></script></body></html>`;

module.exports = {
  chatgpt: shell("chatgpt", `
    <!-- real ChatGPT (Nov 2026) keeps the new-chat composer, hidden, before the live one -->
    <div style="display:none"><form onsubmit="return false">
      <div id="prompt-textarea" class="dead" contenteditable="true"></div>
    </form></div>
    <form onsubmit="return false">
      <div id="prompt-textarea" contenteditable="true"></div>
      <button id="send" type="button" data-testid="send-button">Send</button>
      <button id="stop" type="button" hidden aria-label="Stop">Stop</button>
    </form>`),
  gemini: shell("gemini", `
    <rich-textarea><div class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>
    <button id="send" class="send-button" aria-label="Send message">send</button>
    <button id="stop" hidden aria-label="Stop response">stop</button>`),
  claude: shell("claude", `
    <div class="ProseMirror" contenteditable="true"></div>
    <button id="send" aria-label="Send message">send</button>
    <button id="stop" hidden aria-label="Stop response">stop</button>`),
};
