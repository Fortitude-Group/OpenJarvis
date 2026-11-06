"""Tests for Jarvis's "do it" mode: /v1/act and the job manager.

A fake runner (a tiny Python script speaking the same NDJSON protocol as
runner.mjs) stands in for Node and the Claude Agent SDK.
"""

from __future__ import annotations

import json
import sys
import time

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from openjarvis.server.act_jobs import ActJobManager  # noqa: E402
from openjarvis.server.act_routes import router  # noqa: E402

FAKE_RUNNER = r"""
import json, sys
req = json.loads(sys.stdin.readline())
out = lambda o: (sys.stdout.write(json.dumps(o) + "\n"), sys.stdout.flush())
out({"type": "say", "text": "Working on " + req["task"]})
out({"type": "step", "text": "resume=" + req.get("resume", "")})
if "ask" in req["task"]:
    out({"type": "ask", "id": "q1", "question": "Shall I?"})
    msg = json.loads(sys.stdin.readline())
    if msg.get("type") == "cancel":
        out({"type": "done", "text": "Cancelled."}); sys.exit(0)
    verdict = "allowed" if msg["allow"] else "refused"
    out({"type": "done", "text": verdict, "session_id": "s1"})
elif "crash" in req["task"]:
    sys.exit(3)
else:
    out({"type": "done", "text": "finished", "session_id": "s1"})
"""

JSON = {"Content-Type": "application/json"}


def _client() -> tuple[TestClient, ActJobManager]:
    app = FastAPI()
    app.include_router(router)
    mgr = ActJobManager(command_factory=lambda: [sys.executable, "-c", FAKE_RUNNER])
    app.state.act_jobs = mgr
    return TestClient(app), mgr


def _events(client: TestClient, job_id: str) -> list[dict]:
    with client.stream("GET", f"/v1/act/{job_id}/events") as r:
        assert r.status_code == 200
        return [
            json.loads(line[6:]) for line in r.iter_lines() if line.startswith("data: ")
        ]


def _wait_for(mgr: ActJobManager, job_id: str, kind: str, timeout: float = 10) -> dict:
    end = time.time() + timeout
    while time.time() < end:
        job = mgr.get(job_id)
        for ev in job.events:
            if ev["type"] == kind:
                return ev
        time.sleep(0.02)
    raise AssertionError(f"no {kind} event")


def test_job_streams_events_to_completion():
    client, _ = _client()
    job_id = client.post("/v1/act", json={"task": "open notepad"}).json()["job_id"]
    events = _events(client, job_id)
    assert [e["type"] for e in events] == ["say", "step", "done"]
    assert events[0]["text"] == "Working on open notepad"
    assert events[-1]["text"] == "finished"


@pytest.mark.parametrize("allow,expected", [(True, "allowed"), (False, "refused")])
def test_answer_reaches_the_runner(allow, expected):
    client, mgr = _client()
    job_id = client.post("/v1/act", json={"task": "ask me"}).json()["job_id"]
    ask = _wait_for(mgr, job_id, "ask")
    r = client.post(f"/v1/act/{job_id}/answer", json={"id": ask["id"], "allow": allow})
    assert r.status_code == 200
    assert _events(client, job_id)[-1]["text"] == expected


def test_cancel_finishes_the_job():
    client, mgr = _client()
    job_id = client.post("/v1/act", json={"task": "ask me"}).json()["job_id"]
    _wait_for(mgr, job_id, "ask")
    assert client.post(f"/v1/act/{job_id}/cancel").json() == {"ok": True}
    assert _events(client, job_id)[-1] == {"type": "done", "text": "Cancelled."}


def test_runner_crash_becomes_an_error_event():
    client, _ = _client()
    job_id = client.post("/v1/act", json={"task": "crash"}).json()["job_id"]
    last = _events(client, job_id)[-1]
    assert last["type"] == "error" and "exit 3" in last["text"]


def test_second_job_while_busy_is_rejected():
    client, mgr = _client()
    first = client.post("/v1/act", json={"task": "ask me"}).json()["job_id"]
    _wait_for(mgr, first, "ask")
    r = client.post("/v1/act", json={"task": "another"})
    assert r.status_code == 409 and r.json()["detail"]["running"] == first
    client.post(f"/v1/act/{first}/cancel")


def test_follow_up_resumes_previous_session_unless_fresh():
    client, _ = _client()
    one = client.post("/v1/act", json={"task": "first"}).json()["job_id"]
    _events(client, one)
    two = client.post("/v1/act", json={"task": "second"}).json()["job_id"]
    assert _events(client, two)[1]["text"] == "resume=s1"
    three = client.post("/v1/act", json={"task": "third", "fresh": True}).json()[
        "job_id"
    ]
    assert _events(client, three)[1]["text"] == "resume="


def test_foreign_origin_is_refused():
    client, mgr = _client()
    r = client.post(
        "/v1/act", json={"task": "x"}, headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403
    assert mgr.running() is None


def test_non_json_simple_post_is_refused():
    client, mgr = _client()
    r = client.post(
        "/v1/act", content='{"task":"x"}', headers={"Content-Type": "text/plain"}
    )
    assert r.status_code in (415, 422)
    assert mgr.running() is None


def test_trusted_origins_are_accepted():
    client, _ = _client()
    for origin in ("http://127.0.0.1:8000", "http://tauri.localhost"):
        r = client.post(
            "/v1/act", json={"task": "hi"}, headers={"Origin": origin, **JSON}
        )
        assert r.status_code == 200
        _events(client, r.json()["job_id"])


def test_unknown_job_is_404_and_bad_answer_is_409():
    client, _ = _client()
    assert client.get("/v1/act/nope/events").status_code == 404
    assert (
        client.post("/v1/act/nope/answer", json={"id": "q", "allow": True}).status_code
        == 409
    )


def test_task_length_is_validated():
    client, _ = _client()
    assert client.post("/v1/act", json={"task": ""}).status_code == 422
    assert client.post("/v1/act", json={"task": "x" * 5000}).status_code == 422
