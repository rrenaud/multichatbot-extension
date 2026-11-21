"""Tests for host/askall.py: real daemon + CLI subprocesses, fake extension in-process.

    python3 -m unittest discover -s host/tests -v
"""
import asyncio
import json
import os
import socket
import sys
import tempfile
import unittest

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

HERE = os.path.dirname(os.path.abspath(__file__))
ASKALL = os.path.join(HERE, "..", "askall.py")
EXT_ID = "abcdefghijklmnopabcdefghijklmnop"
ORIGIN = f"chrome-extension://{EXT_ID}"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeExtension:
    """Imitates src/bridge.js. `responder(job) -> results dict` (may be async / delay)."""

    def __init__(self, port, responder, origin=ORIGIN):
        self.port, self.responder, self.origin = port, responder, origin
        self.jobs = []
        self.ws = None
        self.task = None

    async def start(self, retry_s=10.0):
        deadline = asyncio.get_running_loop().time() + retry_s
        while True:
            try:
                self.ws = await connect(f"ws://127.0.0.1:{self.port}/ext", origin=self.origin)
                break
            except OSError:
                if asyncio.get_running_loop().time() > deadline:
                    raise
                await asyncio.sleep(0.1)
        await self.ws.send(json.dumps({"type": "hello", "role": "extension", "version": "test"}))
        self.task = asyncio.create_task(self._loop())
        return self

    async def _loop(self):
        try:
            async for raw in self.ws:
                msg = json.loads(raw)
                if msg.get("type") == "ask":
                    self.jobs.append(msg)
                    asyncio.create_task(self._answer(msg))
        except Exception:
            pass

    async def _answer(self, job):
        r = self.responder(job)
        if asyncio.iscoroutine(r):
            r = await r
        if r is None:
            return
        for site in job["sites"]:
            await self.ws.send(json.dumps({"type": "progress", "id": job["id"], "site": site, "state": "done"}))
        await self.ws.send(json.dumps({"type": "result", "id": job["id"], "results": r}))

    async def close(self):
        if self.ws:
            await self.ws.close()
        if self.task:
            self.task.cancel()


def echo(job):
    return {s: {"ok": True, "text": f"{s}:{job['prompt']}", "html": "<p>x</p>", "url": "u", "ms": 1} for s in job["sites"]}


class AskallTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.home = tempfile.mkdtemp()
        self.port = free_port()
        self.daemon = None
        self.exts = []

    async def asyncTearDown(self):
        for e in self.exts:
            await e.close()
        if self.daemon and self.daemon.returncode is None:
            self.daemon.kill()
            await self.daemon.wait()
        await self.cli("stop")  # in case one was auto-spawned

    async def start_daemon(self, *extra):
        self.daemon = await asyncio.create_subprocess_exec(
            sys.executable, ASKALL, "serve", "--port", str(self.port), "--ext-id", EXT_ID, *extra,
            stderr=asyncio.subprocess.PIPE, env={**os.environ, "ASKALL_HOME": self.home})
        for _ in range(100):
            try:
                ws = await connect(f"ws://127.0.0.1:{self.port}/cli")
                await ws.close()
                return
            except OSError:
                await asyncio.sleep(0.05)
        self.fail("daemon did not start")

    async def ext(self, responder=echo, **kw):
        e = await FakeExtension(self.port, responder, **kw).start()
        self.exts.append(e)
        await asyncio.sleep(0.05)
        return e

    async def cli(self, *args, stdin=None):
        p = await asyncio.create_subprocess_exec(
            sys.executable, ASKALL, *args, "--port", str(self.port), "--ext-id", EXT_ID,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "ASKALL_HOME": self.home})
        out, err = await asyncio.wait_for(p.communicate(stdin.encode() if stdin is not None else b""), 60)
        return p.returncode, out.decode(), err.decode()

    # ------------------------------------------------------------------ security
    async def test_rejects_web_page_origin(self):
        await self.start_daemon()
        for origin in ["https://evil.example", "http://127.0.0.1:8000", "null",
                       "chrome-extension://someotherextensionidxxxxxxxxxxxx"]:
            with self.assertRaises(InvalidStatus, msg=origin) as cm:
                await connect(f"ws://127.0.0.1:{self.port}", origin=origin)
            self.assertEqual(cm.exception.response.status_code, 403)

    async def test_binds_loopback_only(self):
        await self.start_daemon()
        ips = {ai[4][0] for ai in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)} - {"127.0.0.1"}
        for ip in ips:
            with socket.socket() as s:
                s.settimeout(1)
                self.assertNotEqual(s.connect_ex((ip, self.port)), 0, f"daemon reachable on {ip}")

    # ------------------------------------------------------------------ ask
    async def test_round_trip_json(self):
        await self.start_daemon()
        e = await self.ext()
        code, out, err = await self.cli("ask", "hello world", "--sites", "chatgpt,gemini")
        self.assertEqual(code, 0, err)
        j = json.loads(out)
        self.assertEqual(j["results"]["chatgpt"]["text"], "chatgpt:hello world")
        self.assertNotIn("html", j["results"]["gemini"])
        self.assertEqual(e.jobs[0]["sites"], ["chatgpt", "gemini"])
        self.assertTrue(e.jobs[0]["newChat"])
        self.assertEqual(e.jobs[0]["timeoutMs"], 600000)

    async def test_md_html_continue_timeout_activate(self):
        await self.start_daemon()
        e = await self.ext()
        code, out, _ = await self.cli("ask", "q", "--sites", "chatgpt,gemini", "--format", "md", "--continue",
                                      "--timeout", "42", "--activate")
        self.assertEqual(code, 0)
        self.assertEqual(out, "## chatgpt\nchatgpt:q\n\n## gemini\ngemini:q\n")
        self.assertFalse(e.jobs[0]["newChat"])
        self.assertEqual(e.jobs[0]["timeoutMs"], 42000)
        self.assertTrue(e.jobs[0]["activate"])
        code, out, _ = await self.cli("ask", "q", "--sites", "claude", "--html")
        self.assertEqual(json.loads(out)["results"]["claude"]["html"], "<p>x</p>")

    async def test_stdin_prompt_with_quotes_and_newlines(self):
        await self.start_daemon()
        await self.ext()
        prompt = "line 1\nit's \"quoted\" $HOME `x`\nline 3"
        code, out, _ = await self.cli("ask", "--stdin", "--sites", "chatgpt", stdin=prompt + "\n")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["results"]["chatgpt"]["text"], "chatgpt:" + prompt)

    async def test_exit_codes(self):
        await self.start_daemon()

        def some_fail(job):
            r = echo(job)
            r["gemini"] = {"ok": False, "error": "timeout", "stage": "complete", "partial": "half an ans"}
            return r

        e = await self.ext(some_fail)
        code, out, _ = await self.cli("ask", "q", "--sites", "chatgpt,gemini", "--format", "md")
        self.assertEqual(code, 2)
        self.assertIn("_error: timeout (stage: complete)_", out)
        self.assertIn("half an ans", out)
        e.responder = lambda job: {s: {"ok": False, "error": "x", "stage": "fill"} for s in job["sites"]}
        code, _, _ = await self.cli("ask", "q", "--sites", "chatgpt,gemini")
        self.assertEqual(code, 1)

    async def test_concurrent_jobs_routed_to_right_caller(self):
        await self.start_daemon()

        async def slow_first(job):
            # the first prompt answers last
            await asyncio.sleep(1.0 if job["prompt"] == "A" else 0.1)
            return echo(job)

        await self.ext(slow_first)
        (ca, oa, _), (cb, ob, _) = await asyncio.gather(
            self.cli("ask", "A", "--sites", "chatgpt"),
            self.cli("ask", "B", "--sites", "chatgpt"))
        self.assertEqual((ca, cb), (0, 0))
        self.assertEqual(json.loads(oa)["results"]["chatgpt"]["text"], "chatgpt:A")
        self.assertEqual(json.loads(ob)["results"]["chatgpt"]["text"], "chatgpt:B")

    async def test_extension_not_connected(self):
        await self.start_daemon("--ext-wait", "1")
        code, out, _ = await self.cli("ask", "q")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["error"], "extension_not_connected")

    async def test_waits_for_late_extension(self):
        await self.start_daemon("--ext-wait", "10")

        async def late():
            await asyncio.sleep(1.5)
            await self.ext()

        t = asyncio.create_task(late())
        code, out, err = await self.cli("ask", "q", "--sites", "gemini")
        await t
        self.assertEqual(code, 0, out + err)

    async def test_extension_reconnects_mid_job(self):
        await self.start_daemon()
        e1 = await self.ext(lambda job: None)  # receives job, never answers
        cli = asyncio.create_task(self.cli("ask", "q", "--sites", "chatgpt", "-v"))
        for _ in range(100):
            if e1.jobs:
                break
            await asyncio.sleep(0.05)
        job = e1.jobs[0]
        await e1.close()
        # the bridge reconnects and flushes its buffered result
        e2 = await self.ext(lambda j: None)
        await e2.ws.send(json.dumps({"type": "result", "id": job["id"], "results": echo(job)}))
        code, out, err = await cli
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["results"]["chatgpt"]["text"], "chatgpt:q")
        self.assertIn("extension_disconnected", err)

    async def test_newest_extension_wins(self):
        await self.start_daemon()
        old = await self.ext(lambda j: {s: {"ok": True, "text": "OLD"} for s in j["sites"]})
        await self.ext(lambda j: {s: {"ok": True, "text": "NEW"} for s in j["sites"]})
        code, out, _ = await self.cli("ask", "q", "--sites", "chatgpt")
        self.assertEqual(json.loads(out)["results"]["chatgpt"]["text"], "NEW")
        self.assertEqual(old.jobs, [])

    async def test_status_and_stop(self):
        await self.start_daemon()
        code, out, _ = await self.cli("status")
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(out)["extension_connected"])
        await self.ext()
        code, out, _ = await self.cli("status")
        self.assertEqual(code, 0)
        st = json.loads(out)
        self.assertTrue(st["extension_connected"])
        self.assertEqual(st["extension"]["version"], "test")
        code, _, _ = await self.cli("stop")
        self.assertEqual(code, 0)
        await asyncio.wait_for(self.daemon.wait(), 5)

    async def test_autospawn_daemon(self):
        # no daemon yet: the CLI must start one; the "extension" keeps retrying like bridge.js
        ext_task = asyncio.create_task(FakeExtension(self.port, echo).start(retry_s=15))
        code, out, err = await self.cli("ask", "q", "--sites", "chatgpt")
        e = await ext_task
        self.exts.append(e)
        self.assertEqual(code, 0, out + err)
        self.assertIn("started daemon", err)
        self.assertTrue(os.path.exists(os.path.join(self.home, "serve.log")))

    async def test_no_spawn(self):
        code, out, _ = await self.cli("ask", "q", "--no-spawn")
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["error"], "daemon_unavailable")

    async def test_doctor(self):
        await self.start_daemon()

        def pong(job):
            tok = job["prompt"].split()[-1]
            r = {s: {"ok": True, "text": tok, "ms": 5} for s in job["sites"]}
            r["gemini"] = {"ok": False, "error": "no_response_started", "stage": "start"}
            return r

        await self.ext(pong)
        code, out, _ = await self.cli("doctor", "--sites", "chatgpt,gemini")
        self.assertEqual(code, 2)
        self.assertRegex(out, r"ok\s+chatgpt")
        self.assertRegex(out, r"FAIL gemini\s+stage=start")


if __name__ == "__main__":
    unittest.main()
