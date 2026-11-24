/**
 * @file ask.js
 * askall in-browser UI. Opened by the `ask` omnibox keyword (see bridge.js) or directly.
 * Sends prompts to the service worker over a port; the SW drives the chatbot tabs with the
 * same job runner the CLI uses, and streams progress + partial text back.
 *
 * Every multichat is saved in chrome.storage.local (key "askall-h:<id>") and listed in the
 * history sidebar. The open thread's id is in the URL hash (#t=<id>), so reload, back/forward
 * and bookmarks all work. Reopened threads continue the same site conversations: the bridge
 * gets each site's last conversation URL and sends the tab back there if it has moved on.
 */
(() => {
    const S = globalThis.__mcbScrapers;
    const LABELS = { chatgpt: "ChatGPT", gemini: "Gemini", claude: "Claude" };
    const DEFAULT_SITES = ["chatgpt", "gemini", "claude"];
    const ALL_SITES = Object.keys(S.SITES);
    const label = (s) => LABELS[s] || s;
    const PREFIX = "askall-h:";
    const STALE_MS = 15 * 60 * 1000; // pending answers older than this (from a crashed page) are given up on

    const $ = (id) => document.getElementById(id);
    const threadEl = $("thread"), emptyEl = $("empty"), input = $("input"), sendBtn = $("send");

    // SECTION - state
    const load = (store, key, dflt) => {
        try { const v = JSON.parse(store.getItem(key)); return v ?? dflt; } catch (_) { return dflt; }
    };
    const save = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch (_) { /* ignore */ } };

    let selected = load(localStorage, "askall-sites-v2", DEFAULT_SITES).filter((s) => ALL_SITES.includes(s));
    if (!selected.length) selected = DEFAULT_SITES.slice();

    // thread: { id, created, updated, used: [site], urls: {site: conversation url},
    //           turns: [{ id, prompt, sites: { site: {state, text, final, ok, error, detail, stage, tabId, url, ms} } }] }
    const newThread = () => ({ id: "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), created: 0, updated: 0, used: [], urls: {}, turns: [] });
    let thread = newThread();

    // Threads this page has answers in flight for (by thread id), and which thread each job feeds.
    // Kept in memory so answers keep landing in their thread after you switch to another one.
    const mine = new Map();
    const jobs = new Map(); // job id -> thread id
    const pending = (t) => t.turns.some((tu) => Object.values(tu.sites).some((r) => !r.final));

    // Thread list for the sidebar: id -> thread (all of them; they're small).
    let saved = new Map();

    const store = chrome.storage.local;
    const saveTimers = new Map();
    /** Persist a thread; streaming partials are coalesced to one write per 600 ms. */
    function persist(t, now = false) {
        if (!t.turns.length) return;
        t.updated = Date.now();
        if (!t.created) t.created = t.updated;
        saved.set(t.id, t);
        clearTimeout(saveTimers.get(t.id));
        const write = () => { saveTimers.delete(t.id); store.set({ [PREFIX + t.id]: t }).catch(() => {}); };
        if (now) write(); else saveTimers.set(t.id, setTimeout(write, 600));
        renderHistorySoon();
    }

    /** Answers that can never arrive are marked interrupted (and saved). */
    function interrupt(t, why) {
        let changed = false;
        for (const tu of t.turns) {
            for (const r of Object.values(tu.sites)) {
                if (!r.final) { Object.assign(r, { final: true, ok: false, error: "interrupted", detail: why }); changed = true; }
            }
        }
        if (changed) persist(t, true);
    }

    // a reload kills the port, so answers this page was waiting for are lost
    const MINE_KEY = "askall-mine";
    const rememberMine = () => save(sessionStorage, MINE_KEY, [...mine.keys()]);
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
    setInterval(() => { if (mine.size) post({ type: "ping" }); }, 20000);
    //!SECTION

    // SECTION - asking
    function ask(prompt) {
        prompt = prompt.trim();
        if (!prompt || !selected.length) return;
        const t = thread;
        const id = "ui-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const turn = { id, prompt, sites: {} };
        for (const s of selected) turn.sites[s] = { state: "queued", text: "" };
        t.turns.push(turn);

        // sites already in this thread continue their conversation; new ones start fresh
        const cont = selected.filter((s) => t.used.includes(s));
        const fresh = selected.filter((s) => !t.used.includes(s));
        const urls = Object.fromEntries(cont.filter((s) => t.urls[s]).map((s) => [s, t.urls[s]]));
        if (cont.length) post({ type: "ask", id, prompt, sites: cont, newChat: false, urls });
        if (fresh.length) post({ type: "ask", id, prompt, sites: fresh, newChat: true });
        t.used = [...new Set([...t.used, ...selected])];
        jobs.set(id, t.id);
        mine.set(t.id, t);
        rememberMine();

        setHash(t.id);
        setTitle();
        persist(t, true);
        render();
        requestAnimationFrame(() => turnEl(turn.id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    function onMessage(msg) {
        const t = mine.get(jobs.get(msg.id));
        const turn = t?.turns.find((x) => x.id === msg.id);
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
                Object.assign(r, { final: true, ok: res.ok, ms: res.ms, error: res.error, detail: res.detail, stage: res.stage, url: res.url });
                r.text = res.ok ? res.text : (res.partial || r.text || "");
                if (res.ok && res.url) t.urls[site] = res.url;
            }
            jobs.delete(msg.id);
            if (!pending(t)) { mine.delete(t.id); rememberMine(); }
        }
        persist(t, msg.type === "result");
        if (t !== thread) return;
        renderCard(turn, msg.site);
        if (msg.type === "result") { for (const s of Object.keys(turn.sites)) renderCard(turn, s); updateComposer(); }
    }
    //!SECTION

    // SECTION - switching threads
    /** A new question replaces the URL of a blank page; opening another thread is a real navigation. */
    function setHash(id) {
        const h = "#t=" + id;
        if (location.hash === h) return;
        if (location.hash) window.history.pushState(null, "", location.pathname + h);
        else window.history.replaceState(null, "", location.pathname + h);
    }
    const hashId = () => (/^#t=([\w-]+)$/.exec(location.hash) || [])[1] || null;

    function setTitle() {
        document.title = thread.turns.length ? thread.turns[0].prompt.slice(0, 60) + " · askall" : "askall";
    }

    function show(t) {
        thread = t;
        if (!mine.has(t.id) && pending(t) && Date.now() - (t.updated || 0) > STALE_MS) interrupt(t, "the page that asked was closed");
        setTitle();
        render();
        renderHistory();
        if (narrow()) setSide(false);
    }

    async function openThread(id) {
        if (thread.id === id) return;
        const t = mine.get(id) || saved.get(id) || (await store.get(PREFIX + id))[PREFIX + id];
        if (!t) { startNew(); return; }
        setHash(id);
        show(t);
        threadEl.scrollTop = 0;
        window.scrollTo(0, 0);
    }

    function startNew() {
        thread = newThread();
        if (location.hash) window.history.pushState(null, "", location.pathname);
        setTitle();
        render();
        renderHistory();
        input.focus();
    }

    async function deleteThread(id) {
        saved.delete(id);
        clearTimeout(saveTimers.get(id));
        await store.remove(PREFIX + id).catch(() => {});
        if (thread.id === id) startNew();
        else renderHistory();
    }

    window.addEventListener("popstate", () => {
        const id = hashId();
        if (!id) { if (thread.turns.length) { thread = newThread(); setTitle(); render(); renderHistory(); } }
        else if (id !== thread.id) {
            const t = mine.get(id) || saved.get(id);
            if (t) show(t);
        }
    });

    // other askall pages write threads too: keep the list current, and follow a thread another
    // page is answering into while we display it
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        let touched = false;
        for (const [key, { newValue }] of Object.entries(changes)) {
            if (!key.startsWith(PREFIX)) continue;
            const id = key.slice(PREFIX.length);
            if (mine.has(id)) continue; // we're the writer
            if (newValue && (saved.get(id)?.updated || 0) >= newValue.updated) continue; // our own write
            touched = true;
            if (newValue) saved.set(id, newValue); else saved.delete(id);
            if (thread.id === id) {
                if (!newValue) { startNew(); continue; }
                thread = newValue;
                setTitle();
                render();
            }
        }
        if (touched) renderHistorySoon();
    });
    //!SECTION

    // SECTION - history sidebar
    const side = $("side"), list = $("history"), search = $("search");
    const narrow = () => matchMedia("(max-width: 900px)").matches;
    function setSide(open) {
        document.body.classList.toggle("side-open", open);
        document.body.classList.toggle("side-closed", !open);
        $("toggleSide").setAttribute("aria-expanded", String(open));
        if (!narrow()) save(localStorage, "askall-side-open", open);
    }
    setSide(narrow() ? false : load(localStorage, "askall-side-open", true));
    $("toggleSide").onclick = () => setSide(!document.body.classList.contains("side-open"));
    $("scrim").onclick = () => setSide(false);

    let historyTimer = null;
    const renderHistorySoon = () => { clearTimeout(historyTimer); historyTimer = setTimeout(renderHistory, 150); };
    search.addEventListener("input", renderHistorySoon);

    const matches = (t, q) => !q || t.turns.some((tu) =>
        tu.prompt.toLowerCase().includes(q) || Object.values(tu.sites).some((r) => (r.text || "").toLowerCase().includes(q)));

    function bucket(ts) {
        const d = new Date(ts), now = new Date();
        const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
        const diff = Math.round((day(now) - day(d)) / 86400000);
        if (diff <= 0) return "Today";
        if (diff === 1) return "Yesterday";
        if (diff < 7) return "Previous 7 days";
        if (diff < 30) return "Previous 30 days";
        return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    function when(ts) {
        const d = new Date(ts);
        return bucket(ts) === "Today" || bucket(ts) === "Yesterday"
            ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
            : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }

    function renderHistory() {
        const q = search.value.trim().toLowerCase();
        const all = [...saved.values()].filter((t) => t.turns?.length).sort((a, b) => b.updated - a.updated);
        const shown = all.filter((t) => matches(t, q));
        list.replaceChildren();
        $("historyEmpty").hidden = shown.length > 0;
        $("historyEmpty").textContent = all.length ? "Nothing matches." : "Your multichats will be listed here.";
        let group = null;
        for (const t of shown) {
            const g = bucket(t.updated);
            if (g !== group) {
                group = g;
                const h = document.createElement("h2");
                h.className = "history-group";
                h.textContent = g;
                list.append(h);
            }
            list.append(historyItem(t));
        }
    }

    function historyItem(t) {
        const item = document.createElement("div");
        item.className = "h-item";
        item.dataset.id = t.id;
        if (t.id === thread.id) item.setAttribute("aria-current", "page");

        const a = document.createElement("a");
        a.className = "h-link";
        a.href = "#t=" + t.id;
        a.onclick = (e) => { e.preventDefault(); openThread(t.id); };
        const title = document.createElement("span");
        title.className = "h-title";
        title.textContent = t.turns[0].prompt;
        const meta = document.createElement("span");
        meta.className = "h-meta";
        const sites = [...new Set(t.turns.flatMap((tu) => Object.keys(tu.sites)))];
        for (const s of sites) {
            const dot = document.createElement("span");
            dot.className = "dot";
            dot.title = label(s);
            dot.style.setProperty("--site", `var(--${s}, var(--accent))`);
            meta.append(dot);
        }
        const n = t.turns.length;
        meta.append(`${n > 1 ? n + " turns · " : ""}${when(t.updated)}`);
        if (pending(t)) {
            const live = document.createElement("span");
            live.className = "h-live";
            live.title = "answers still coming in";
            meta.append(live);
        }
        a.append(title, meta);

        const del = document.createElement("button");
        del.className = "h-del";
        del.type = "button";
        del.title = "Delete from history (the site conversations stay)";
        del.setAttribute("aria-label", "Delete " + t.turns[0].prompt.slice(0, 40));
        del.textContent = "×";
        del.onclick = () => {
            // two-step: the first click asks
            item.classList.add("confirming");
            const box = document.createElement("div");
            box.className = "h-confirm";
            box.innerHTML = `<span>Delete?</span><button type="button" class="yes">Delete</button><button type="button" class="no">Keep</button>`;
            box.querySelector(".yes").onclick = () => deleteThread(t.id);
            box.querySelector(".no").onclick = () => { item.classList.remove("confirming"); box.remove(); };
            item.append(box);
            box.querySelector(".no").focus();
        };
        item.append(a, del);
        return item;
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
        card.querySelector(".open").disabled = !r.tabId && !r.url;
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
                    `<button class="copy" title="Copy markdown">Copy</button><button class="open" title="Show this conversation on the site">Open tab ↗</button></div>` +
                    `<div class="body"></div><div class="body error" hidden></div>`;
                card.querySelector(".name").textContent = label(site);
                card.querySelector(".open").onclick = () => {
                    const r = turn.sites[site];
                    post({ type: "focus", tabId: r.tabId, url: r.url || thread.urls?.[site] });
                };
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
    $("newChat").onclick = startNew;
    //!SECTION

    // SECTION - startup
    (async () => {
        const all = await store.get(null).catch(() => ({}));
        for (const [k, v] of Object.entries(all)) if (k.startsWith(PREFIX) && v?.turns) saved.set(v.id, v);

        // this page was reloaded while waiting: those answers will never arrive
        for (const id of load(sessionStorage, MINE_KEY, [])) {
            const t = saved.get(id);
            if (t) interrupt(t, "page was reloaded while waiting");
        }
        sessionStorage.removeItem(MINE_KEY);

        // the question from the address bar asks once in a fresh thread (dropped from the URL so a
        // reload shows the thread instead of asking again); otherwise reopen #t=<id>
        const q = new URLSearchParams(location.search).get("q");
        const id = hashId();
        if (q) {
            window.history.replaceState(null, "", location.pathname);
            render();
            renderHistory();
            ask(q);
        } else if (id && saved.has(id)) {
            show(saved.get(id));
        } else {
            if (id) window.history.replaceState(null, "", location.pathname);
            render();
            renderHistory();
        }
        input.focus();
    })();
    //!SECTION
})();
