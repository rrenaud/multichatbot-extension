/**
 * @file scrapers.js
 * askall: per-site selectors + response scraping / completion detection.
 *
 * THIS IS THE ONE PLACE TO EDIT SELECTORS for the askall sites (chatgpt, gemini, claude).
 * Every selector list is tried in order; the first match wins. See TODO-LIVE.md for the
 * checklist of what still needs verifying against the live sites.
 *
 * Loaded twice:
 *   - as a content script (listed before content.js in manifest.json) → DOM helpers used
 *   - imported by the service worker (src/bridge.js) → only the SITES config is used
 * So: no DOM access at top level, and everything hangs off globalThis.__mcbScrapers.
 */
(function (g) {
    "use strict";

    // SECTION - Site config (EDIT HERE)
    const SITES = {
        chatgpt: {
            hosts: ["chatgpt.com"],
            tabUrlPatterns: ["https://chatgpt.com/*"],
            newChatUrl: "https://chatgpt.com/",
            // composer
            input: [
                'div#prompt-textarea[contenteditable="true"]',
                "#prompt-textarea",
            ],
            send: [
                'button[data-testid="send-button"]',
                "button#composer-submit-button",
            ],
            // response
            assistant: ['[data-message-author-role="assistant"]'],
            content: [".markdown"], // inside the assistant node; falls back to the node
            generating: [
                'button[data-testid="stop-button"]',
                'button[aria-label="Stop streaming"]',
            ],
            strip: ["button", "svg", ".sr-only"],
        },
        gemini: {
            hosts: ["gemini.google.com"],
            tabUrlPatterns: ["https://gemini.google.com/*"],
            newChatUrl: "https://gemini.google.com/app",
            input: [
                'rich-textarea .ql-editor[contenteditable="true"]',
                ".ql-editor",
                'div[contenteditable="true"][role="textbox"]',
            ],
            send: [
                'button.send-button:not([aria-disabled="true"])',
                'button[aria-label="Send message"]',
                'button[aria-label*="Send" i]',
            ],
            assistant: ["model-response"],
            content: ["message-content .markdown", "message-content"],
            generating: [
                'button[aria-label*="Stop" i]',
            ],
            strip: ["button", "mat-icon", "model-thoughts", ".thoughts-header", "sources-list", "svg"],
        },
        claude: {
            hosts: ["claude.ai"],
            tabUrlPatterns: ["https://claude.ai/*"],
            newChatUrl: "https://claude.ai/new",
            input: [
                'div.ProseMirror[contenteditable="true"]',
                'div[aria-label="Write your prompt to Claude"][contenteditable="true"]',
                'div[contenteditable="true"]',
            ],
            send: [
                'button[aria-label="Send message"]',
                'button[aria-label="Send Message"]',
                "button.bg-accent-main-000",
            ],
            assistant: [".font-claude-response", "[data-is-streaming]"],
            content: [],
            generating: [
                '[data-is-streaming="true"]',
                'button[aria-label="Stop response"]',
            ],
            strip: ["button", "svg"],
        },
    };

    const DEFAULTS = {
        quietMs: 2000, // text must be unchanged this long (and no "generating" signal)
        startTimeoutMs: 60000, // no new assistant node within this → no_response_started
        timeoutMs: 600000, // hard cap per request
        inputWaitMs: 20000, // SPA boot: wait this long for the composer to appear
        pollMs: 500, // backstop poll (MutationObserver is the main trigger)
    };
    //!SECTION

    function siteKeyForHost(hostname) {
        for (const [key, s] of Object.entries(SITES)) {
            if (s.hosts.some((h) => hostname === h || hostname.endsWith("." + h))) return key;
        }
        return null;
    }

    // SECTION - DOM helpers (content-script only)
    function qsFirst(selectors, root = document) {
        for (const sel of selectors || []) {
            try {
                const el = root.querySelector(sel);
                if (el) return el;
            } catch (_) { /* bad selector: skip */ }
        }
        return null;
    }

    function qsAllCount(sel) {
        try { return document.querySelectorAll(sel).length; } catch (_) { return 0; }
    }

    /** Wait until one of `selectors` matches (MutationObserver + poll). */
    function waitForSelector(selectors, timeoutMs) {
        return new Promise((resolve) => {
            const found = qsFirst(selectors);
            if (found) return resolve(found);
            let done = false;
            const finish = (el) => {
                if (done) return;
                done = true;
                obs.disconnect();
                clearInterval(poll);
                clearTimeout(timer);
                resolve(el);
            };
            const check = () => { const el = qsFirst(selectors); if (el) finish(el); };
            const obs = new MutationObserver(check);
            obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
            const poll = setInterval(check, DEFAULTS.pollMs);
            const timer = setTimeout(() => finish(null), timeoutMs);
        });
    }

    /** Count assistant nodes per selector. Call BEFORE sending. */
    function snapshot(siteKey) {
        return SITES[siteKey].assistant.map(qsAllCount);
    }

    /** Last assistant node that appeared after `baseline`, or null. */
    function newestNode(siteKey, baseline) {
        const sels = SITES[siteKey].assistant;
        for (let i = 0; i < sels.length; i++) {
            let list;
            try { list = document.querySelectorAll(sels[i]); } catch (_) { continue; }
            if (list.length > (baseline[i] || 0)) return list[list.length - 1];
        }
        return null;
    }

    /** True if any "generating" selector matches a *rendered* element (hidden ones don't count). */
    function isGenerating(siteKey) {
        for (const sel of SITES[siteKey].generating) {
            let list;
            try { list = document.querySelectorAll(sel); } catch (_) { continue; }
            for (const el of list) if (el.getClientRects().length) return true;
        }
        return false;
    }

    /** Extract { text (markdown-ish), html } from an assistant node. */
    function extract(siteKey, node) {
        const site = SITES[siteKey];
        const container = qsFirst(site.content, node) || node;
        const clone = container.cloneNode(true);
        for (const sel of site.strip || []) {
            try { clone.querySelectorAll(sel).forEach((el) => el.remove()); } catch (_) { /* skip */ }
        }
        return { text: htmlToMarkdown(clone), html: container.innerHTML };
    }

    // Active waiters, so the service worker can "tick" us (timers in hidden tabs are
    // throttled to 1/s, or 1/min after 5 min; extension messages are not).
    const waiters = new Set();
    function tick() { waiters.forEach((fn) => fn()); }

    /**
     * Wait for the response that follows a send, per IMPLEMENTATION.md §M1.
     * @param {string} siteKey
     * @param {number[]} baseline - from snapshot() taken before sending
     * @param {object} [opts] - { timeoutMs, quietMs, startTimeoutMs, onProgress(state) }
     */
    function waitForResponse(siteKey, baseline, opts = {}) {
        const timeoutMs = opts.timeoutMs || DEFAULTS.timeoutMs;
        const quietMs = opts.quietMs || DEFAULTS.quietMs;
        const startTimeoutMs = Math.min(opts.startTimeoutMs || DEFAULTS.startTimeoutMs, timeoutMs);
        const onProgress = opts.onProgress || (() => {});
        const t0 = Date.now();

        return new Promise((resolve) => {
            let node = null;
            let lastText = null;
            let lastChange = Date.now();
            let started = false;
            let done = false;

            const finish = (r) => {
                if (done) return;
                done = true;
                obs.disconnect();
                clearInterval(poll);
                clearTimeout(hard);
                waiters.delete(check);
                resolve({ ...r, url: location.href, ms: Date.now() - t0 });
            };

            function current() {
                try { return node ? extract(siteKey, node) : { text: "", html: "" }; }
                catch (e) { return { text: "", html: "" }; }
            }

            function check() {
                if (done) return;
                const now = Date.now();
                if (!node || !node.isConnected) {
                    // (re)resolve: SPAs sometimes re-render the whole thread
                    node = newestNode(siteKey, baseline);
                    if (!node) {
                        if (!started && now - t0 > startTimeoutMs) {
                            finish({ ok: false, error: "no_response_started", stage: "start", partial: "" });
                        }
                        return;
                    }
                    if (!started) {
                        started = true;
                        onProgress("generating");
                    }
                }
                const { text, html } = current();
                if (text !== lastText) {
                    lastText = text;
                    lastChange = now;
                }
                const generating = isGenerating(siteKey);
                if (!generating && text.trim() && now - lastChange >= quietMs) {
                    finish({ ok: true, text: text.trim(), html });
                    return;
                }
                if (now - t0 > timeoutMs) {
                    finish({ ok: false, error: "timeout", stage: "complete", partial: text, generating });
                }
            }

            const obs = new MutationObserver(check);
            obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
            const poll = setInterval(check, DEFAULTS.pollMs);
            const hard = setTimeout(check, timeoutMs + 50);
            waiters.add(check);
            check();
        });
    }
    //!SECTION

    // SECTION - HTML → markdown (small turndown substitute; keeps code fences)
    const BLOCK = new Set([
        "P", "DIV", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN", "ASIDE", "FIGURE",
        "UL", "OL", "LI", "TABLE", "THEAD", "TBODY", "TR", "BLOCKQUOTE", "PRE", "HR",
        "H1", "H2", "H3", "H4", "H5", "H6", "DL", "DT", "DD", "DETAILS", "SUMMARY",
        "MESSAGE-CONTENT", "RESPONSE-ELEMENT",
    ]);
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "BUTTON", "TEXTAREA", "INPUT"]);

    function htmlToMarkdown(root) {
        const out = conv(root, { depth: 0, inPre: false });
        return out
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function children(el, ctx) {
        let s = "";
        el.childNodes.forEach((c) => { s += conv(c, ctx); });
        return s;
    }

    function block(s) {
        s = s.trim();
        return s ? "\n\n" + s + "\n\n" : "";
    }

    function conv(n, ctx) {
        if (n.nodeType === 3) {
            return ctx.inPre ? n.nodeValue : n.nodeValue.replace(/\s+/g, " ");
        }
        if (n.nodeType !== 1 && n.nodeType !== 11) return "";
        if (n.nodeType === 11) return children(n, ctx);
        const tag = n.tagName.toUpperCase();
        if (SKIP.has(tag)) return "";

        // KaTeX: prefer the TeX source over the doubled MathML/HTML rendering
        if (n.classList && n.classList.contains("katex")) {
            const ann = n.querySelector('annotation[encoding="application/x-tex"]');
            if (ann) return n.closest(".katex-display") ? "\n\n$$" + ann.textContent + "$$\n\n" : "$" + ann.textContent + "$";
        }

        switch (tag) {
            case "BR":
                return "\n";
            case "HR":
                return "\n\n---\n\n";
            case "H1": case "H2": case "H3": case "H4": case "H5": case "H6":
                return block("#".repeat(+tag[1]) + " " + children(n, ctx).trim());
            case "PRE": {
                const code = n.querySelector("code") || n;
                const m = (code.className || "").match(/language-([\w+#.-]+)/);
                const lang = m ? m[1] : "";
                const body = code.textContent.replace(/\n$/, "");
                return "\n\n```" + lang + "\n" + body + "\n```\n\n";
            }
            case "CODE":
                return ctx.inPre ? n.textContent : "`" + n.textContent + "`";
            case "STRONG": case "B": {
                const t = children(n, ctx);
                return t.trim() ? "**" + t.trim() + "**" : t;
            }
            case "EM": case "I": {
                const t = children(n, ctx);
                return t.trim() ? "*" + t.trim() + "*" : t;
            }
            case "A": {
                const t = children(n, ctx).trim();
                const href = n.getAttribute("href");
                return href && t && !href.startsWith("javascript:") ? "[" + t + "](" + href + ")" : t;
            }
            case "UL": case "OL": {
                let i = parseInt(n.getAttribute("start") || "1", 10);
                const ordered = tag === "OL";
                const indent = "   ".repeat(ctx.depth);
                let s = "";
                n.childNodes.forEach((li) => {
                    if (li.nodeType !== 1 || li.tagName.toUpperCase() !== "LI") return;
                    const marker = ordered ? (i++) + ". " : "- ";
                    const inner = children(li, { ...ctx, depth: ctx.depth + 1 })
                        .trim()
                        .replace(/\n{2,}/g, "\n")
                        .replace(/\n(?!\s*(?:[-*]|\d+\.) )/g, "\n" + indent + "   ");
                    s += indent + marker + inner + "\n";
                });
                return ctx.depth ? "\n" + s : block(s);
            }
            case "BLOCKQUOTE":
                return block(children(n, ctx).trim().split("\n").map((l) => "> " + l).join("\n"));
            case "TABLE": {
                const rows = [...n.querySelectorAll("tr")].map((tr) =>
                    [...tr.children].map((c) => children(c, ctx).trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")));
                if (!rows.length) return "";
                const w = Math.max(...rows.map((r) => r.length));
                const line = (r) => "| " + Array.from({ length: w }, (_, k) => r[k] || "").join(" | ") + " |";
                const out = [line(rows[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)];
                return block(out.join("\n"));
            }
            default: {
                const s = children(n, ctx);
                return BLOCK.has(tag) ? block(s) : s;
            }
        }
    }
    //!SECTION

    g.__mcbScrapers = {
        SITES,
        DEFAULTS,
        siteKeyForHost,
        qsFirst,
        waitForSelector,
        snapshot,
        newestNode,
        isGenerating,
        extract,
        waitForResponse,
        htmlToMarkdown,
        tick,
    };
})(globalThis);
