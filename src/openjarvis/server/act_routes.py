"""HTTP API for Jarvis's "do it" mode.

    POST /v1/act                     {task, context?, fresh?}  -> {job_id}
    GET  /v1/act/{job_id}/events     server-sent events, replayed from the start
    POST /v1/act/{job_id}/answer     {id, allow}
    POST /v1/act/{job_id}/cancel

These endpoints can drive the whole PC, so every call must come from the HUD
or a local non-browser client. A browser on any other site can still fire a
"simple" cross-origin POST at localhost (CORS only hides the response), so
the Origin header and a JSON content type are checked here explicitly.
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from openjarvis.server.act_jobs import ActJobManager

TRUSTED_ORIGINS = frozenset(
    {
        "http://127.0.0.1:8000",
        "http://localhost:8000",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    }
)
MAX_TASK_CHARS = 4000
MAX_CONTEXT_CHARS = 12000
HEARTBEAT_S = 15.0


class ActRequest(BaseModel):
    task: str = Field(min_length=1, max_length=MAX_TASK_CHARS)
    context: str = Field(default="", max_length=MAX_CONTEXT_CHARS)
    fresh: bool = False


class AnswerRequest(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    allow: bool


def _guard(request: Request, *, body: bool) -> None:
    origin = request.headers.get("origin")
    if origin is not None and origin not in TRUSTED_ORIGINS:
        raise HTTPException(status_code=403, detail="origin not allowed")
    if body and "application/json" not in request.headers.get("content-type", ""):
        raise HTTPException(status_code=415, detail="send application/json")


def _manager(request: Request) -> ActJobManager:
    mgr: Optional[ActJobManager] = getattr(request.app.state, "act_jobs", None)
    if mgr is None:
        mgr = ActJobManager()
        request.app.state.act_jobs = mgr
    return mgr


router = APIRouter(prefix="/v1/act", tags=["act"])


@router.post("")
async def start_job(payload: ActRequest, request: Request) -> dict:
    _guard(request, body=True)
    try:
        job = _manager(request).start(
            payload.task.strip(), payload.context, payload.fresh
        )
    except RuntimeError as busy:
        raise HTTPException(status_code=409, detail={"running": str(busy)})
    return {"job_id": job.id}


@router.get("/{job_id}/events")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    _guard(request, body=False)
    job = _manager(request).get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")

    async def stream():
        sent = 0
        while True:
            while sent < len(job.events):
                yield f"data: {json.dumps(job.events[sent])}\n\n"
                sent += 1
            if job.finished and sent >= len(job.events):
                return
            if await request.is_disconnected():
                return
            await job.wait_beyond(sent, HEARTBEAT_S)
            if sent >= len(job.events) and not job.finished:
                yield ": keep-alive\n\n"

    return StreamingResponse(
        stream(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"}
    )


@router.post("/{job_id}/answer")
async def answer(job_id: str, payload: AnswerRequest, request: Request) -> dict:
    _guard(request, body=True)
    if not _manager(request).answer(job_id, payload.id, payload.allow):
        raise HTTPException(
            status_code=409, detail="job is not waiting on that question"
        )
    return {"ok": True}


@router.post("/{job_id}/cancel")
async def cancel(job_id: str, request: Request) -> dict:
    _guard(request, body=False)
    return {"ok": _manager(request).cancel(job_id)}
