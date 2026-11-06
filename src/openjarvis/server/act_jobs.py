"""Jobs for Jarvis's "do it" mode.

Each job runs ``agents/agent_runner/runner.mjs`` (the Claude Agent SDK) as a
child process and speaks newline-delimited JSON with it: the task goes in on
stdin, progress events come back on stdout, and yes/no answers or a cancel go
back in on stdin. Events are kept on the job so an SSE client can join late or
reconnect without missing anything.

Threads (not asyncio subprocesses) drive the pipes because uvicorn on Windows
may run a selector event loop, which cannot spawn subprocesses.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from openjarvis.core.paths import get_config_dir

logger = logging.getLogger(__name__)

RUNNER_SRC = Path(__file__).resolve().parents[1] / "agents" / "agent_runner"
RUNNER_FILES = (
    "package.json",
    "runner.mjs",
    "desktop.mjs",
    "policy.mjs",
    "desktop.ps1",
)
# A follow-up within this window carries on the previous agent session, so
# "now add it to the basket" knows what "it" is.
RESUME_WINDOW_S = 15 * 60
TERMINAL = {"done", "error"}


def ensure_runner(dest: Optional[Path] = None) -> Path:
    """Copy the runner next to its node_modules and install them once."""
    if shutil.which("node") is None:
        raise RuntimeError("Jarvis 'do it' mode needs Node.js 22 or newer on PATH.")
    dest = dest or get_config_dir() / "agent_runner"
    dest.mkdir(parents=True, exist_ok=True)
    for name in RUNNER_FILES:
        shutil.copy2(RUNNER_SRC / name, dest / name)
    if not (dest / "node_modules" / "@anthropic-ai" / "claude-agent-sdk").exists():
        logger.info("Installing agent runner dependencies in %s", dest)
        npm = shutil.which("npm") or "npm"
        subprocess.run(
            [npm, "install", "--no-audit", "--no-fund"],
            cwd=str(dest),
            check=True,
            capture_output=True,
            timeout=600,
        )
    return dest


def default_command() -> List[str]:
    return [shutil.which("node") or "node", str(ensure_runner() / "runner.mjs")]


@dataclass
class ActJob:
    id: str
    task: str
    events: List[dict] = field(default_factory=list)
    finished: bool = False
    finished_at: float = 0.0
    session_id: str = ""
    proc: Optional[subprocess.Popen] = None
    _waiters: List[tuple] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def add_event(self, event: dict) -> None:
        with self._lock:
            self.events.append(event)
            if event.get("type") in TERMINAL:
                self.finished = True
                self.finished_at = time.time()
                self.session_id = event.get("session_id") or self.session_id
            waiters, self._waiters = self._waiters, []
        for loop, ev in waiters:
            loop.call_soon_threadsafe(ev.set)

    async def wait_beyond(self, index: int, timeout: float) -> None:
        """Wait until there are more than *index* events, the job ends, or timeout."""
        ev = asyncio.Event()
        with self._lock:
            if len(self.events) > index or self.finished:
                return
            self._waiters.append((asyncio.get_running_loop(), ev))
        try:
            await asyncio.wait_for(ev.wait(), timeout)
        except asyncio.TimeoutError:
            pass

    def send(self, message: dict) -> bool:
        proc = self.proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            return False
        try:
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            return False


class ActJobManager:
    """Starts and tracks agent jobs. One job runs at a time."""

    def __init__(
        self, command_factory: Callable[[], List[str]] = default_command
    ) -> None:
        self._command_factory = command_factory
        self._jobs: Dict[str, ActJob] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Optional[ActJob]:
        return self._jobs.get(job_id)

    def running(self) -> Optional[ActJob]:
        return next((j for j in self._jobs.values() if not j.finished), None)

    def _resume_id(self) -> str:
        done = [j for j in self._jobs.values() if j.finished and j.session_id]
        if not done:
            return ""
        last = max(done, key=lambda j: j.finished_at)
        return (
            last.session_id if time.time() - last.finished_at < RESUME_WINDOW_S else ""
        )

    def start(self, task: str, context: str = "", fresh: bool = False) -> ActJob:
        with self._lock:
            busy = self.running()
            if busy is not None:
                raise RuntimeError(busy.id)
            job = ActJob(id=uuid.uuid4().hex[:12], task=task)
            self._jobs[job.id] = job
            resume = "" if fresh else self._resume_id()
        threading.Thread(
            target=self._run, args=(job, context, resume), daemon=True
        ).start()
        return job

    def _run(self, job: ActJob, context: str, resume: str) -> None:
        try:
            proc = subprocess.Popen(
                self._command_factory(),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as exc:  # node missing, npm install failed, ...
            logger.exception("Could not start the agent runner")
            job.add_event(
                {"type": "error", "text": f"Could not start the agent: {exc}"}
            )
            return
        job.proc = proc
        threading.Thread(target=self._drain_stderr, args=(proc,), daemon=True).start()
        job.send({"task": job.task, "context": context, "resume": resume})
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("runner: %s", line)
                continue
            if isinstance(event, dict) and "type" in event:
                job.add_event(event)
        proc.wait()
        if not job.finished:
            job.add_event(
                {
                    "type": "error",
                    "text": f"The agent stopped unexpectedly (exit {proc.returncode}).",
                }
            )

    @staticmethod
    def _drain_stderr(proc: subprocess.Popen) -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            logger.debug("runner stderr: %s", line.rstrip())

    def answer(self, job_id: str, ask_id: str, allow: bool) -> bool:
        job = self.get(job_id)
        return bool(job and job.send({"type": "answer", "id": ask_id, "allow": allow}))

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.finished:
            return False
        job.send({"type": "cancel"})
        proc = job.proc

        def _kill_later() -> None:
            time.sleep(5)
            if proc is not None and proc.poll() is None:
                proc.kill()

        threading.Thread(target=_kill_later, daemon=True).start()
        return True
