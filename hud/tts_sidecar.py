"""Kokoro TTS sidecar for the JARVIS HUD.

POST /tts  {"text": "...", "voice": "bm_george"}  ->  audio/wav  (Kokoro)

Runs from the OpenJarvis clone venv (which has kokoro + the accent-aware
kokoro_tts backend installed). The HUD page fetches this for JARVIS's voice
and pipes the playback through a Web Audio analyser so the reactor reacts to
the actual speech.

Run:  uv run python hud/tts_sidecar.py        (listens on http://localhost:8731)
"""
from __future__ import annotations

import io
import logging

import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

import openjarvis.speech  # noqa: F401  registers TTS + STT backends
from openjarvis.core.registry import SpeechRegistry, TTSRegistry

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("jarvis-voice")

app = FastAPI(title="JARVIS voice sidecar")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

_backend = TTSRegistry.get("kokoro")()
# Local STT via this clone's (Windows-fixed) faster-whisper backend, so the HUD
# never depends on the separate :8000 backend (which lacks faster-whisper).
_stt = SpeechRegistry.get("faster-whisper")(
    model_size="base", device="cuda", compute_type="float16"
)


class Req(BaseModel):
    text: str
    voice: str = "bm_george"
    speed: float = 1.0


@app.on_event("startup")
def _warm() -> None:
    # Pre-load the British pipeline + voice so the first real request is fast.
    try:
        _backend.synthesize("Online, sir.", voice_id="bm_george", output_format="wav")
        log.info("Kokoro warm — bm_george ready")
    except Exception as exc:  # pragma: no cover
        log.warning("warmup failed: %s", exc)


@app.get("/health")
def health() -> dict:
    return {"ok": _backend.health(), "voice": "bm_george", "stt": "faster-whisper"}


@app.post("/stt")
async def stt(file: UploadFile = File(...)) -> dict:
    """Transcribe uploaded audio locally (fixed faster-whisper)."""
    audio = await file.read()
    name = file.filename or "audio.webm"
    ext = name.rsplit(".", 1)[-1] if "." in name else "webm"
    if not audio:
        return {"text": ""}
    res = _stt.transcribe(audio, format=ext, language="en")
    return {"text": res.text, "language": res.language}


@app.post("/tts")
def tts(req: Req) -> Response:
    text = (req.text or "").strip()
    log.info("tts<- (%d chars) %r", len(text), text[:64])
    if not text:
        return Response(status_code=204)
    res = _backend.synthesize(
        text, voice_id=req.voice, speed=req.speed, output_format="wav"
    )
    buf = io.BytesIO(res.audio)
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8731, log_level="warning")
