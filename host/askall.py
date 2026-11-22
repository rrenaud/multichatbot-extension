#!/usr/bin/env python3
"""askall: ask your logged-in ChatGPT / Gemini / Claude browser tabs from the command line.

    askall serve  [--port 47821] [--ext-id ID]   # daemon the extension connects to
    askall ask "prompt" [--sites chatgpt,gemini,claude] [--continue] [--timeout 600]
                        [--format json|md] [--stdin] [--activate] [--html] [-v]
    askall status                                # is the daemon up / extension connected?
    askall doctor [--sites ...]                  # PONG test per site, reports failing stage
    askall stop                                  # stop the daemon

Security model: the daemon binds 127.0.0.1 only and accepts WebSocket connections
  - with Origin chrome-extension://<EXT_ID>  -> the extension
  - with no Origin header                    -> a local CLI process
and rejects everything else (web pages always send an Origin they can't forge).

See IMPLEMENTATION.md for the full design.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import subprocess
import sys
import time
import uuid
from pathlib import Path

try:
    from websockets.asyncio.client import connect
    from websockets.asyncio.server import serve
    from websockets.exceptions import ConnectionClosed
except ImportError:  # pragma: no cover
    sys.stderr.write("askall: needs the 'websockets' package (>=13): pip install 'websockets>=13'\n")
    sys.exit(1)

DEFAULT_PORT = int(os.environ.get("ASKALL_PORT", "47821"))
# Pinned via the "key" in manifest.json. Override with ASKALL_EXT_ID or --ext-id
# (comma-separated list allowed; "any" accepts any chrome-extension:// origin, for dev only).
DEFAULT_EXT_ID = "memcomanbbccgomhdecjgcnhihgiaepb"
DEFAULT_SITES = os.environ.get("ASKALL_SITES", "chatgpt,gemini,claude")
EXT_WAIT_S = 35.0  # one reconnect-alarm cycle (30 s) + slack
MAX_MSG = 64 * 1024 * 1024

log = logging.getLogger("askall")


def state_dir() -> Path:
    d = Path(os.environ.get("ASKALL_HOME", Path.home() / ".askall"))
    d.mkdir(parents=True, exist_ok=True)
    return d


# --------------------------------------------------------------------------- daemon
class Daemon:
    def __init__(self, ext_ids: set[str], ext_wait: float = EXT_WAIT_S):
        self.ext_ids = ext_ids
        self.ext_wait = ext_wait
        self.ext = None  # current extension connection (newest wins)
        self.ext_hello: dict = {}
        self.ext_connected = asyncio.Event()
        self.jobs: dict[str, object] = {}  # job id -> CLI connection
        self.stopping = asyncio.Event()

    # ---- handshake
    def classify(self, origin: str | None) -> str | None:
        if origin is None:
            return "cli"
        prefix = "chrome-extension://"
        if origin.startswith(prefix):
            ext_id = origin[len(prefix):].rstrip("/")
            if "any" in self.ext_ids or ext_id in self.ext_ids:
                return "extension"
        return None

    def process_request(self, connection, request):
        origin = request.headers.get("Origin")
        role = self.classify(origin)
        if role is None:
            log.warning("rejected connection with Origin %r", origin)
            return connection.respond(403, "Forbidden origin\n")
        connection.askall_role = role
        return None

    async def handler(self, ws):
        role = getattr(ws, "askall_role", None)
        if role == "extension":
            await self.handle_extension(ws)
        elif role == "cli":
            await self.handle_cli(ws)

    # ---- extension side
    async def handle_extension(self, ws):
        old, self.ext = self.ext, ws
        self.ext_connected.set()
        log.info("extension connected (%d pending jobs)", len(self.jobs))
        if old is not None:
            await old.close(4000, "replaced by newer connection")
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                t = msg.get("type")
                if t == "hello":
                    self.ext_hello = msg
                elif t in ("progress", "result"):
                    job_id = msg.get("id")
                    cli = self.jobs.get(job_id)
                    if cli is not None:
                        await self._safe_send(cli, raw)
                    if t == "result":
                        self.jobs.pop(job_id, None)
                        log.info("job %s done", job_id)
        except ConnectionClosed:
            pass
        finally:
            if self.ext is ws:
                self.ext = None
                self.ext_connected.clear()
                log.info("extension disconnected")
                # Jobs stay mapped: the bridge buffers results and resends after reconnecting.
                for job_id, cli in list(self.jobs.items()):
                    await self._safe_send(cli, json.dumps(
                        {"type": "progress", "id": job_id, "site": None, "state": "extension_disconnected"}))

    # ---- CLI side
    async def handle_cli(self, ws):
        tasks = set()
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except ValueError:
                    await self._safe_send(ws, json.dumps({"type": "error", "error": "bad_json"}))
                    continue
                t = msg.get("type")
                if t == "ask":
                    task = asyncio.create_task(self.start_job(ws, msg))
                    tasks.add(task)
                    task.add_done_callback(tasks.discard)
                elif t == "status":
                    await self._safe_send(ws, json.dumps(self.status()))
                elif t == "stop":
                    await self._safe_send(ws, json.dumps({"type": "stopping"}))
                    self.stopping.set()
                elif t == "reload":
                    ok = False
                    if self.ext is not None:
                        try:
                            await self.ext.send(json.dumps({"type": "reload"}))
                            ok = True
                        except ConnectionClosed:
                            pass
                    await self._safe_send(ws, json.dumps({"type": "reloading", "ok": ok}))
                else:
                    await self._safe_send(ws, json.dumps({"type": "error", "error": f"unknown type {t!r}"}))
        except ConnectionClosed:
            pass
        finally:
            for task in tasks:
                task.cancel()
            for job_id in [j for j, c in self.jobs.items() if c is ws]:
                self.jobs.pop(job_id, None)

    async def start_job(self, ws, msg):
        job_id = uuid.uuid4().hex[:12]
        self.jobs[job_id] = ws
        await self._safe_send(ws, json.dumps({"type": "accepted", "id": job_id}))
        job = {
            "type": "ask",
            "id": job_id,
            "prompt": msg.get("prompt", ""),
            "sites": msg.get("sites") or DEFAULT_SITES.split(","),
            "newChat": msg.get("newChat", True),
            "timeoutMs": msg.get("timeoutMs", 600_000),
            "activate": bool(msg.get("activate", False)),
        }
        deadline = time.monotonic() + self.ext_wait
        while True:
            ext = self.ext
            if ext is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                try:
                    await asyncio.wait_for(self.ext_connected.wait(), remaining)
                except asyncio.TimeoutError:
                    break
                continue
            try:
                await ext.send(json.dumps(job))
                log.info("job %s -> extension (%s)", job_id, ",".join(job["sites"]))
                return
            except ConnectionClosed:
                await asyncio.sleep(0.1)  # it dropped between check and send; wait for the next one
        self.jobs.pop(job_id, None)
        await self._safe_send(ws, json.dumps({"type": "result", "id": job_id, "error": "extension_not_connected"}))

    def status(self) -> dict:
        return {
            "type": "status",
            "extension_connected": self.ext is not None,
            "extension": {k: v for k, v in self.ext_hello.items() if k != "type"} if self.ext else None,
            "accepted_extension_ids": sorted(self.ext_ids),
            "pending_jobs": len(self.jobs),
            "pid": os.getpid(),
        }

    @staticmethod
    async def _safe_send(ws, data: str):
        try:
            await ws.send(data)
        except ConnectionClosed:
            pass


async def run_server(port: int, ext_ids: set[str], ext_wait: float) -> int:
    daemon = Daemon(ext_ids, ext_wait)
    try:
        server = await serve(daemon.handler, "127.0.0.1", port,
                             process_request=daemon.process_request, max_size=MAX_MSG)
    except OSError as e:
        log.error("cannot listen on 127.0.0.1:%d (%s); is another `askall serve` running?", port, e)
        return 3
    log.info("askall serve on ws://127.0.0.1:%d, accepting extension id(s): %s", port, ", ".join(sorted(ext_ids)))
    async with server:
        await daemon.stopping.wait()
        await asyncio.sleep(0.05)
    return 0


def parse_ext_ids(arg: str | None) -> set[str]:
    raw = arg or os.environ.get("ASKALL_EXT_ID") or DEFAULT_EXT_ID
    ids = {s.strip() for s in raw.split(",") if s.strip()}
    if "any" in ids:
        log.warning("accepting ANY chrome-extension:// origin (dev mode)")
    return ids


# --------------------------------------------------------------------------- client
class DaemonUnavailable(Exception):
    pass


async def open_conn(port: int, autospawn: bool, ext_id_arg: str | None):
    uri = f"ws://127.0.0.1:{port}/cli"
    try:
        return await connect(uri, max_size=MAX_MSG, open_timeout=5)
    except OSError:
        if not autospawn:
            raise DaemonUnavailable(f"no askall daemon on port {port}")
    spawn_daemon(port, ext_id_arg)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        await asyncio.sleep(0.2)
        try:
            return await connect(uri, max_size=MAX_MSG, open_timeout=5)
        except OSError:
            continue
    raise DaemonUnavailable(f"started `askall serve` but could not connect; see {state_dir() / 'serve.log'}")


def spawn_daemon(port: int, ext_id_arg: str | None):
    cmd = [sys.executable, os.path.abspath(__file__), "serve", "--port", str(port)]
    if ext_id_arg:
        cmd += ["--ext-id", ext_id_arg]
    logf = open(state_dir() / "serve.log", "ab")
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=logf, stderr=logf, close_fds=True)
    if os.name == "nt":  # pragma: no cover
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(cmd, **kwargs)
    sys.stderr.write(f"askall: started daemon on port {port} (log: {state_dir() / 'serve.log'})\n")


async def ask(prompt: str, sites: list[str], *, port: int, new_chat: bool, timeout_s: float,
              activate: bool = False, autospawn: bool = True, ext_id_arg: str | None = None,
              on_progress=None) -> dict:
    """Returns the daemon's result message: {"type":"result","id",...,"results":{...}} or {...,"error":...}."""
    ws = await open_conn(port, autospawn, ext_id_arg)
    async with ws:
        await ws.send(json.dumps({
            "type": "ask", "prompt": prompt, "sites": sites, "newChat": new_chat,
            "timeoutMs": int(timeout_s * 1000), "activate": activate,
        }))
        job_id = None
        # daemon waits <=35 s for the extension; bridge adds tab setup + 90 s guard
        deadline = time.monotonic() + timeout_s + EXT_WAIT_S + 120
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {"type": "result", "id": job_id, "error": "cli_timeout"}
            try:
                raw = await asyncio.wait_for(ws.recv(), remaining)
            except asyncio.TimeoutError:
                continue
            except ConnectionClosed:
                return {"type": "result", "id": job_id, "error": "daemon_connection_lost"}
            msg = json.loads(raw)
            t = msg.get("type")
            if t == "accepted":
                job_id = msg["id"]
            elif t == "progress" and on_progress:
                on_progress(msg)
            elif t == "result" and msg.get("id") == job_id:
                return msg


async def simple_request(port: int, msg: dict) -> dict:
    ws = await open_conn(port, autospawn=False, ext_id_arg=None)
    async with ws:
        await ws.send(json.dumps(msg))
        return json.loads(await asyncio.wait_for(ws.recv(), 10))


# --------------------------------------------------------------------------- output
def clean_results(results: dict, include_html: bool) -> dict:
    out = {}
    for site, r in results.items():
        r = dict(r or {})
        if not include_html:
            r.pop("html", None)
        out[site] = r
    return out


def exit_code(msg: dict) -> int:
    results = msg.get("results") or {}
    if msg.get("error") or not results:
        return 1
    oks = [bool(r and r.get("ok")) for r in results.values()]
    if all(oks):
        return 0
    return 2 if any(oks) else 1


def to_markdown(msg: dict) -> str:
    if msg.get("error"):
        return f"**askall error:** {msg['error']}\n"
    parts = []
    for site, r in (msg.get("results") or {}).items():
        if r.get("ok"):
            parts.append(f"## {site}\n{r.get('text', '')}")
        else:
            body = f"## {site}\n_error: {r.get('error')} (stage: {r.get('stage', '?')})_"
            if r.get("detail"):
                body += f"\n_detail: {r['detail']}_"
            if r.get("partial"):
                body += f"\n\npartial answer:\n{r['partial']}"
            parts.append(body)
    return "\n\n".join(parts) + "\n"


# --------------------------------------------------------------------------- commands
def cmd_serve(args) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s askall %(levelname)s %(message)s")
    return asyncio.run(run_server(args.port, parse_ext_ids(args.ext_id), args.ext_wait))


def cmd_ask(args) -> int:
    if args.stdin or (not args.prompt and not sys.stdin.isatty()):
        prompt = sys.stdin.read()
    else:
        prompt = " ".join(args.prompt)
    prompt = prompt.strip("\n")
    if not prompt.strip():
        sys.stderr.write("askall: empty prompt\n")
        return 1
    sites = [s.strip() for s in args.sites.split(",") if s.strip()]

    def progress(m):
        if args.verbose:
            sys.stderr.write(f"askall: [{m.get('site') or '-'}] {m.get('state')}\n")

    try:
        msg = asyncio.run(ask(prompt, sites, port=args.port, new_chat=not args.cont, timeout_s=args.timeout,
                              activate=args.activate, autospawn=not args.no_spawn, ext_id_arg=args.ext_id,
                              on_progress=progress))
    except DaemonUnavailable as e:
        msg = {"type": "result", "error": "daemon_unavailable", "detail": str(e)}

    if args.format == "md":
        sys.stdout.write(to_markdown(msg))
    else:
        out = {"prompt": prompt, "sites": sites}
        if msg.get("error"):
            out["error"] = msg["error"]
            if msg.get("detail"):
                out["detail"] = msg["detail"]
            if msg["error"] == "extension_not_connected":
                out["hint"] = ("Is Chrome running with the extension loaded? Its ID must match "
                               "ASKALL_EXT_ID / --ext-id (see `askall status`).")
        out["results"] = clean_results(msg.get("results") or {}, args.html)
        json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
    return exit_code(msg)


def cmd_status(args) -> int:
    try:
        st = asyncio.run(simple_request(args.port, {"type": "status"}))
    except DaemonUnavailable:
        print(json.dumps({"daemon_running": False, "port": args.port}, indent=2))
        return 1
    st.pop("type", None)
    print(json.dumps({"daemon_running": True, "port": args.port, **st}, indent=2))
    return 0 if st.get("extension_connected") else 1


def cmd_reload(args) -> int:
    try:
        r = asyncio.run(simple_request(args.port, {"type": "reload"}))
    except DaemonUnavailable:
        print("askall: no daemon running")
        return 1
    if not r.get("ok"):
        print("askall: extension not connected")
        return 1
    print("askall: extension reloading (reconnects in a few seconds)")
    return 0


def cmd_stop(args) -> int:
    try:
        asyncio.run(simple_request(args.port, {"type": "stop"}))
    except DaemonUnavailable:
        print("askall: no daemon running")
        return 1
    print("askall: daemon stopped")
    return 0


STAGE_HINTS = {
    "setup": "tab/content script problem: is the site open & logged in? reload the tab.",
    "fill": "composer not found or not fillable: check SITES.<site>.input in src/scrapers.js",
    "send": "send button not found/clickable: check SITES.<site>.send (Enter fallback also failed)",
    "start": "prompt sent but no new assistant node: check SITES.<site>.assistant (or the send didn't really go through)",
    "complete": "answer never finished: check SITES.<site>.generating (stuck visible?) or raise --timeout",
    "bridge": "extension-side failure (tab closed/navigated?)",
}


def cmd_doctor(args) -> int:
    sites = [s.strip() for s in args.sites.split(",") if s.strip()]
    token = f"PONG-{secrets.token_hex(3).upper()}"
    prompt = f"Reply with exactly {token}"
    print(f"askall doctor: port {args.port}, sites {', '.join(sites)}")
    try:
        msg = asyncio.run(ask(prompt, sites, port=args.port, new_chat=True, timeout_s=args.timeout,
                              activate=args.activate, ext_id_arg=args.ext_id,
                              on_progress=lambda m: print(f"  .. [{m.get('site') or '-'}] {m.get('state')}")))
    except DaemonUnavailable as e:
        print(f"  FAIL daemon: {e}")
        return 1
    if msg.get("error"):
        print(f"  FAIL {msg['error']}")
        if msg["error"] == "extension_not_connected":
            print("       Chrome running with the unpacked extension? ID mismatch? try `askall status`.")
        return 1
    bad = 0
    for s in sites:
        r = (msg.get("results") or {}).get(s) or {}
        if r.get("ok") and token in r.get("text", ""):
            print(f"  ok   {s:8} {r.get('ms', '?')} ms")
        elif r.get("ok"):
            bad += 1
            print(f"  WARN {s:8} answered but token missing: {r.get('text', '')[:120]!r}")
            print(f"       (scraped the wrong node? check SITES.{s}.assistant/content)")
        else:
            bad += 1
            stage = r.get("stage", "?")
            print(f"  FAIL {s:8} stage={stage} error={r.get('error')} {r.get('detail', '')}")
            print(f"       {STAGE_HINTS.get(stage, '')}")
    return 0 if not bad else (2 if bad < len(sites) else 1)


def main(argv=None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"daemon port (default {DEFAULT_PORT})")
    common.add_argument("--ext-id", default=None,
                        help="allowed extension id(s), comma-separated (default: $ASKALL_EXT_ID or the pinned id)")
    p = argparse.ArgumentParser(prog="askall", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    add = lambda name, **kw: sub.add_parser(name, parents=[common], **kw)

    sp = add("serve", help="run the daemon")
    sp.add_argument("--ext-wait", type=float, default=EXT_WAIT_S, help=argparse.SUPPRESS)
    sp.set_defaults(fn=cmd_serve)

    ap = add("ask", help="ask the bots")
    ap.add_argument("prompt", nargs="*")
    ap.add_argument("--sites", default=DEFAULT_SITES)
    ap.add_argument("--continue", dest="cont", action="store_true", help="follow up in the same conversations")
    ap.add_argument("--timeout", type=float, default=600, help="seconds per site (default 600)")
    ap.add_argument("--format", choices=["json", "md"], default="json")
    ap.add_argument("--stdin", action="store_true", help="read the prompt from stdin")
    ap.add_argument("--activate", action="store_true", help="briefly focus each tab before sending")
    ap.add_argument("--html", action="store_true", help="include raw HTML in JSON output")
    ap.add_argument("--no-spawn", action="store_true", help="don't auto-start the daemon")
    ap.add_argument("-v", "--verbose", action="store_true", help="progress on stderr")
    ap.set_defaults(fn=cmd_ask)

    add("status", help="daemon / extension status").set_defaults(fn=cmd_status)
    add("stop", help="stop the daemon").set_defaults(fn=cmd_stop)
    add("reload", help="reload the unpacked extension (after editing its files)").set_defaults(fn=cmd_reload)

    dp = add("doctor", help="PONG test per site")
    dp.add_argument("--sites", default=DEFAULT_SITES)
    dp.add_argument("--timeout", type=float, default=180)
    dp.add_argument("--activate", action="store_true")
    dp.set_defaults(fn=cmd_doctor)

    args = p.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
