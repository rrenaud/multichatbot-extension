// Mock chatbot engine used by test/e2e.js. Served at https://<site>/__mock/engine.js via
// Playwright routing. It imitates the DOM shape that src/scrapers.js expects for each
// site (as best guessed). It does NOT prove the real sites match, only that our
// fill → send → wait → scrape pipeline works against that shape.
(function () {
  const SITE = document.documentElement.dataset.site;
  const $ = (s) => document.querySelector(s);
  const editor = $("[contenteditable]");
  const thread = $("#thread");
  let sendBtn = $("#send");
  const stopBtn = $("#stop");
  let streaming = false;

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Editors on gemini (Quill) / claude (ProseMirror) handle paste; chatgpt mock doesn't,
  // so content.js falls through to execCommand there. Both paths get exercised.
  if (SITE !== "chatgpt") {
    editor.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = e.clipboardData.getData("text/plain");
      editor.innerHTML = t.split("\n").map((l) => "<p>" + (esc(l) || "<br>") + "</p>").join("");
      updateBtn();
    });
  }
  function updateBtn() {
    sendBtn.disabled = !editor.innerText.trim() || streaming;
  }
  editor.addEventListener("input", updateBtn);
  updateBtn();

  function longHtml() {
    let h = "<h2>Long answer</h2>";
    for (let i = 1; i <= 30; i++) {
      h += `<p>Paragraph ${i}: ` + "lorem ipsum dolor sit amet ".repeat(8) + `<strong>bold${i}</strong>.</p>`;
    }
    h += "<ul><li>alpha</li><li>beta<ul><li>beta-1</li></ul></li></ul>";
    h += '<pre><div class="code-header"><span>python</span><button>Copy code</button></div>' +
      '<code class="language-python">def f(x):\n    return x &lt; 2\n\nprint(f(1))\n</code></pre>';
    h += "<p>Middle text with <code>inline()</code>.</p>";
    h += '<pre><code class="language-js">const a = [1, 2];\nconsole.log(a.map((v) =&gt; v * 2));\n</code></pre>';
    h += "<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>";
    h += "<p>END-OF-LONG</p>";
    return h;
  }

  function makeNode() {
    const wrap = document.createElement("div");
    let content;
    if (SITE === "chatgpt") {
      wrap.setAttribute("data-message-author-role", "assistant");
      wrap.innerHTML = '<div class="markdown prose"></div><button>Copy</button>';
      content = wrap.querySelector(".markdown");
    } else if (SITE === "gemini") {
      wrap.innerHTML = '<model-response><model-thoughts><div class="thoughts-header">Show thinking</div></model-thoughts>' +
        '<message-content><div class="markdown"></div></message-content><button>thumb_up</button></model-response>';
      content = wrap.querySelector(".markdown");
    } else {
      wrap.setAttribute("data-is-streaming", "true");
      wrap.innerHTML = '<div class="font-claude-response"></div>';
      content = wrap.querySelector(".font-claude-response");
    }
    thread.appendChild(wrap);
    return { wrap, content };
  }

  function setGenerating(on) {
    streaming = on;
    stopBtn.hidden = !on;
    if (SITE === "chatgpt") {
      // real ChatGPT swaps send-button for stop-button; mimic by toggling presence
      if (on) stopBtn.setAttribute("data-testid", "stop-button");
      else stopBtn.removeAttribute("data-testid");
    }
    updateBtn();
  }

  async function respond(prompt) {
    const user = document.createElement("div");
    if (SITE === "chatgpt") user.setAttribute("data-message-author-role", "user");
    user.className = "user-msg";
    user.textContent = prompt;
    thread.appendChild(user);
    if (/NEVER/.test(prompt)) return;

    setGenerating(true);
    await sleep(300);
    const { wrap, content } = makeNode();

    let html;
    const m = prompt.match(/Reply with exactly (\S+)/);
    if (m) html = "<p>" + esc(m[1]) + "</p>";
    else if (/LONG/.test(prompt)) html = longHtml();
    else if (/ECHO/.test(prompt)) html = "<p>" + prompt.split("\n").map(esc).join("<br>") + "</p>";
    else html = "<p>mock answer</p>";

    if (/THINK/.test(prompt)) {
      // long silent "thinking" phase: no DOM changes while generating signal is up
      await sleep(5000);
    }
    // stream in chunks, tag-safe: split on '>' boundaries
    const chunks = html.match(/[^>]*>|[^>]+$/g);
    let acc = "";
    for (const c of chunks) {
      acc += c;
      content.innerHTML = acc;
      await sleep(/HANG/.test(prompt) ? 400 : 15);
    }
    if (/HANG/.test(prompt)) { for (;;) { content.innerHTML += "."; await sleep(400); } }
    if (/PAUSE/.test(prompt)) {
      // mid-stream pause longer than quietMs while still "generating"
      await sleep(3500);
      content.innerHTML += "<p>AFTER-PAUSE</p>";
    }
    if (SITE === "claude") wrap.setAttribute("data-is-streaming", "false");
    setGenerating(false);
  }

  sendBtn.addEventListener("click", () => {
    if (sendBtn.disabled) return;
    const prompt = editor.innerText.replace(/\n$/, "");
    editor.innerHTML = "";
    updateBtn();
    respond(prompt);
  });
  window.__mockReady = true;
})();
