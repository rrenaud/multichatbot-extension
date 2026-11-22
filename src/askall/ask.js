/**
 * @file ask.js
 * askall in-browser UI. Opened by the `ask` omnibox keyword (see bridge.js) or directly.
 * Sends prompts to the service worker over a port; the SW drives the chatbot tabs with the
 * same job runner the CLI uses, and streams progress + partial text back.
 * The thread lives in sessionStorage, so a reload of this tab keeps the answers.
 */
(() => {
    const S = globalThis.__mcbScrapers;
    const LABELS = { chatgpt: "ChatGPT", gemini: "Gemini", claude: "Claude" };
    const DEFAULT_SITES = ["chatgpt", "gemini", "claude"];
    const ALL_SITES = Object.keys(S.SITES);
    const label = (s) => LABELS[s] || s;

    const $ = (id) => document.getElementById(id);
    const threadEl = $("thread"), emptyEl = $("empty"), input = $("input"), sendBtn = $("send");

    // SECTION - state
    const load = (store, key, dflt) => {
        try { const v = JSON.parse(store.getItem(key)); return v ?? dflt; } catch (_) { return dflt; }
    };
    const save = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch (_) { /* ignore */ } };

    let selected = load(localStorage, "askall-sites-v2", DEFAULT_SITES).filter((s) => ALL_SITES.includes(s));
    if (!selected.length) selected = DEFAULT_SITES.slice();
    // thread: { turns: [{ id, prompt, sites: { site: {state, text, ok, error, detail, tabId, ms} } }], used: [site] }
    let thread = load(sessionStorage, "askall-thread", { turns: [], used: [] });
    const saveThread = () => save(sessionStorage, "askall-thread", thread);

    // answers that were still running when the page was reloaded will never arrive
    for (const t of thread.turns) {
        for (const r of Object.values(t.sites)) {
            if (!r.final) Object.assign(r, { final: true, ok: false, error: "interrupted", detail: "page was reloaded while waiting" });
        }
    }
    //!SECTION

    // SECTION - port to the service worker
    let port = null;
    function connect() {
        port = chrome.runtime.connect({ name: "askall-ui" });
        port.onMessage.addListener(onMessage);
        port.onDisconnect.addListener(() => { port = null; });
    }
    function post(msg) {
        if (!port) connect();
        port.postMessage(msg);
    }
    connect();
    // messages keep the service worker from idling out while answers stream
    setInterval(() => { if (busy()) post({ type: "ping" }); }, 20000);
    //!SECTION

    // SECTION - asking
    const busy = () => thread.turns.some((t) => Object.values(t.sites).some((r) => !r.final));

    function ask(prompt) {
        prompt = prompt.trim();
        if (!prompt || !selected.length) return;
        const id = "ui-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const turn = { id, prompt, sites: {} };
        for (const s of selected) turn.sites[s] = { state: "queued", text: "" };
        thread.turns.push(turn);

        // sites already in this thread continue their conversation; new ones start fresh
        const cont = selected.filter((s) => thread.used.includes(s));
        const fresh = selected.filter((s) => !thread.used.includes(s));
        if (cont.length) post({ type: "ask", id, prompt, sites: cont, newChat: false });
        if (fresh.length) post({ type: "ask", id, prompt, sites: fresh, newChat: true });
        thread.used = [...new Set([...thread.used, ...selected])];

        if (thread.turns.length === 1) document.title = prompt.slice(0, 60) + " · askall";
        saveThread();
        render();
        requestAnimationFrame(() => turnEl(turn.id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    function onMessage(msg) {
        const turn = thread.turns.find((t) => t.id === msg.id);
        if (!turn) return;
        if (msg.type === "progress") {
            const r = turn.sites[msg.site];
            if (!r || r.final) return;
            if (msg.tabId) r.tabId = msg.tabId;
            if (msg.state === "partial") { r.text = msg.text || r.text; r.state = "generating"; }
            else if (msg.state !== "done") r.state = msg.state;
        } else if (msg.type === "result") {
            if (msg.error) {
                for (const r of Object.values(turn.sites)) {
                    if (!r.final) Object.assign(r, { final: true, ok: false, error: msg.error });
                }
            }
            for (const [site, res] of Object.entries(msg.results || {})) {
                const r = turn.sites[site];
                if (!r) continue;
                Object.assign(r, { final: true, ok: res.ok, ms: res.ms, error: res.error, detail: res.detail, stage: res.stage });
                r.text = res.ok ? res.text : (res.partial || r.text || "");
            }
        }
        saveThread();
        renderCard(turn, msg.site);
        if (msg.type === "result") { for (const s of Object.keys(turn.sites)) renderCard(turn, s); updateComposer(); }
    }
    //!SECTION

    // SECTION - rendering
    // LaTeX via KaTeX, as a marked extension so code spans/blocks are never touched.
    // Block: $$…$$ or \[…\] on their own lines. Inline: \(…\), $$…$$, and $…$ (not "$5 and $10":
    // no space just inside the dollars and no digit right after the closing one).
    function tex(src, display) {
        try {
            return katex.renderToString(src, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
        } catch (_) {
            const span = document.createElement("code");
            span.textContent = src;
            return span.outerHTML;
        }
    }
    marked.use({
        extensions: [
            {
                name: "mathBlock",
                level: "block",
                start: (src) => src.match(/^ {0,3}(\$\$|\\\[)/m)?.index,
                tokenizer(src) {
                    const m = /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
                    if (m) return { type: "mathBlock", raw: m[0], text: (m[1] ?? m[2]).trim() };
                },
                renderer: (t) => `<div class="math-display">${tex(t.text, true)}</div>\n`,
            },
            {
                name: "mathInline",
                level: "inline",
                start: (src) => src.match(/\$|\\\(/)?.index,
                tokenizer(src) {
                    let m = /^\$\$([^$]+?)\$\$/.exec(src);
                    if (m) return { type: "mathInline", raw: m[0], text: m[1].trim(), display: true };
                    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
                    if (m) return { type: "mathInline", raw: m[0], text: m[1].trim(), display: false };
                    m = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
                    if (m) return { type: "mathInline", raw: m[0], text: m[1], display: false };
                },
                renderer: (t) => tex(t.text, t.display),
            },
        ],
    });

    function md(text) {
        const html = marked.parse(text || "", { gfm: true });
        const tpl = document.createElement("template");
        tpl.innerHTML = html;
        tpl.content.querySelectorAll("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
        return tpl.content;
    }

    const STATUS = {
        queued: "waiting for tab…",
        tab: "tab ready",
        sent: "sent",
        generating: "writing",
    };

    function statusOf(r) {
        if (!r.final) return { text: STATUS[r.state] || r.state, cls: "busy" };
        if (r.ok) return { text: `done · ${(r.ms / 1000).toFixed(1)}s`, cls: "ok" };
        return { text: r.error === "interrupted" ? "interrupted" : `failed (${r.stage || "?"})`, cls: "err" };
    }

    const turnEl = (id) => threadEl.querySelector(`.turn[data-id="${id}"]`);

    function renderCard(turn, site) {
        const card = turnEl(turn.id)?.querySelector(`.card[data-site="${site}"]`);
        const r = turn.sites[site];
        if (!card || !r) return;
        const st = statusOf(r);
        const status = card.querySelector(".status");
        status.textContent = st.text;
        status.className = "status " + st.cls;
        card.querySelector(".open").disabled = !r.tabId;
        card.querySelector(".copy").disabled = !r.text;

        const body = card.querySelector(".body");
        const err = card.querySelector(".error");
        body.replaceChildren();
        body.className = "body";
        if (r.text) body.append(md(r.text));
        else if (!(r.final && !r.ok)) {
            body.className = "body placeholder";
            body.textContent = r.final ? "(empty answer)" : "…";
        }
        body.hidden = !r.text && r.final && !r.ok;
        err.hidden = !(r.final && !r.ok);
        if (!err.hidden) {
            err.textContent = `${r.error}${r.detail ? ": " + r.detail : ""}` +
                (r.error === "content_script_unavailable" || r.stage === "fill" ? "\nCheck you're logged in on that tab." : "");
        }
    }

    function render() {
        emptyEl.hidden = thread.turns.length > 0;
        threadEl.querySelectorAll(".turn").forEach((el) => el.remove());
        for (const turn of thread.turns) {
            const el = document.createElement("section");
            el.className = "turn";
            el.dataset.id = turn.id;
            const p = document.createElement("p");
            p.className = "prompt";
            p.textContent = turn.prompt;
            const grid = document.createElement("div");
            grid.className = "answers";
            for (const site of Object.keys(turn.sites)) {
                const card = document.createElement("article");
                card.className = "card";
                card.dataset.site = site;
                card.style.setProperty("--site", `var(--${site}, var(--accent))`);
                card.innerHTML = `<div class="card-head"><span class="name"></span><span class="status"></span>` +
                    `<button class="copy" title="Copy markdown">Copy</button><button class="open" title="Show this tab">Open tab ↗</button></div>` +
                    `<div class="body"></div><div class="body error" hidden></div>`;
                card.querySelector(".name").textContent = label(site);
                card.querySelector(".open").onclick = () => turn.sites[site].tabId && post({ type: "focus", tabId: turn.sites[site].tabId });
                card.querySelector(".copy").onclick = async (ev) => {
                    await navigator.clipboard.writeText(turn.sites[site].text || "");
                    ev.target.textContent = "Copied";
                    setTimeout(() => (ev.target.textContent = "Copy"), 1200);
                };
                grid.append(card);
            }
            el.append(p, grid);
            threadEl.append(el);
            for (const site of Object.keys(turn.sites)) renderCard(turn, site);
        }
        renderSites();
        updateComposer();
    }

    function renderSites() {
        const box = $("sites");
        box.replaceChildren();
        for (const site of ALL_SITES) {
            const b = document.createElement("button");
            b.className = "chip";
            b.type = "button";
            b.style.setProperty("--site", `var(--${site}, var(--accent))`);
            b.setAttribute("aria-pressed", String(selected.includes(site)));
            b.innerHTML = `<span class="dot"></span>`;
            b.append(label(site));
            b.onclick = () => {
                selected = selected.includes(site) ? selected.filter((s) => s !== site) : [...selected, site];
                selected.sort((a, b2) => ALL_SITES.indexOf(a) - ALL_SITES.indexOf(b2));
                save(localStorage, "askall-sites-v2", selected);
                renderSites();
                updateComposer();
            };
            box.append(b);
        }
    }

    function updateComposer() {
        const names = selected.map(label);
        const who = names.length ? names.join(" and ").replace(/ and (?=.* and )/g, ", ") : "nobody (pick a site above)";
        input.placeholder = thread.turns.length ? `Follow up with ${who}…` : `Ask ${who}…`;
        sendBtn.disabled = !selected.length;
    }
    //!SECTION

    // SECTION - composer
    const grow = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
    input.addEventListener("input", grow);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            $("composer").requestSubmit();
        }
    });
    $("composer").addEventListener("submit", (e) => {
        e.preventDefault();
        const text = input.value;
        if (!text.trim() || !selected.length) return;
        input.value = "";
        grow();
        ask(text);
    });
    $("newChat").onclick = () => {
        thread = { turns: [], used: [] };
        saveThread();
        document.title = "askall";
        render();
        input.focus();
    };
    //!SECTION

    // first render, then the question from the address bar (once: drop it from the URL so a
    // reload doesn't ask again — the thread itself is restored from sessionStorage)
    render();
    const q = new URLSearchParams(location.search).get("q");
    if (q) {
        history.replaceState(null, "", location.pathname);
        ask(q);
    } else if (thread.turns.length) {
        document.title = thread.turns[0].prompt.slice(0, 60) + " · askall";
    }
    input.focus();
})();
