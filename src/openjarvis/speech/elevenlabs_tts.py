"""ElevenLabs TTS backend — premium neural voice (refined British male for JARVIS).

Why this exists: the local Kokoro voice bakes unnatural mid-sentence pauses into its
output. ElevenLabs produces natural, cinematic speech with no such artifacts and a
British male preset ("George") that suits JARVIS. Enabled automatically when
ELEVENLABS_API_KEY is set (see the /v1/speech/tts route).
"""

from __future__ import annotations

import os
from typing import List

import httpx

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

_EL_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
# "George" preset — British, warm, mature. Override with ELEVENLABS_VOICE_ID.
_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"
# turbo = good quality + low latency for conversational use. Override w/ ELEVENLABS_MODEL.
_DEFAULT_MODEL = "eleven_turbo_v2_5"


@TTSRegistry.register("elevenlabs")
class ElevenLabsTTSBackend(TTSBackend):
    """ElevenLabs cloud TTS — natural neural speech, streamed back as MP3."""

    backend_id = "elevenlabs"

    def __init__(self, *, api_key: str = "", voice_id: str = "", model: str = "") -> None:
        self._api_key = api_key or os.environ.get("ELEVENLABS_API_KEY", "")
        self._voice_id = voice_id or os.environ.get("ELEVENLABS_VOICE_ID", "") or _DEFAULT_VOICE
        self._model = model or os.environ.get("ELEVENLABS_MODEL", "") or _DEFAULT_MODEL

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "",
        speed: float = 1.0,
        output_format: str = "mp3",
    ) -> TTSResult:
        if not self._api_key:
            raise RuntimeError("ELEVENLABS_API_KEY not set")

        # The HUD passes a Kokoro voice id (bm_*/af_*/am_*); ignore those and use the
        # configured ElevenLabs voice. Only honour an explicit ElevenLabs voice id.
        vid = voice_id if (voice_id and not voice_id[:3] in ("bm_", "af_", "am_", "bf_")) else self._voice_id

        settings = {"stability": 0.45, "similarity_boost": 0.85, "style": 0.0, "use_speaker_boost": True}
        try:
            spd = float(speed)
            if 0.7 <= spd <= 1.2:
                settings["speed"] = spd
        except (TypeError, ValueError):
            pass

        resp = httpx.post(
            f"{_EL_BASE}/{vid}",
            params={"output_format": "mp3_44100_128"},
            headers={
                "xi-api-key": self._api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={"text": text, "model_id": self._model, "voice_settings": settings},
            timeout=120.0,
        )
        resp.raise_for_status()

        return TTSResult(
            audio=resp.content,
            format="mp3",
            voice_id=vid,
            metadata={"backend": "elevenlabs", "model": self._model},
        )

    def available_voices(self) -> List[str]:
        # A couple of JARVIS-suited British male presets; the active one is first.
        return [self._voice_id, "JBFqnCBsd6RMkjVDRZzb", "onwK4e9ZLuTAKqWW03F9"]

    def health(self) -> bool:
        return bool(self._api_key)
