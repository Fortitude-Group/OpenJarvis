"""Kokoro TTS backend — fully open-source, runs locally.

Requires the kokoro package: pip install kokoro
Falls back gracefully if not installed.
"""

from __future__ import annotations

import io
from typing import List

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult


@TTSRegistry.register("kokoro")
class KokoroTTSBackend(TTSBackend):
    """Kokoro TTS — local open-source voice synthesis."""

    backend_id = "kokoro"

    def __init__(self, *, model_path: str = "", device: str = "auto") -> None:
        self._model_path = model_path
        self._device = device
        self._pipelines: dict = {}

    # Kokoro voice ids are prefixed by language/region: "a*" = US English,
    # "b*" = British English (plus e/f/h/i/j/p/z for other languages). The
    # pipeline's lang_code drives phonemization, so it must match the voice's
    # prefix — otherwise a British voice is given American pronunciation (and
    # Kokoro logs a mismatch warning).
    @staticmethod
    def _lang_for_voice(voice_id: str) -> str:
        prefix = voice_id[0] if voice_id else "a"
        return prefix if prefix in {"a", "b", "e", "f", "h", "i", "j", "p", "z"} else "a"

    def _ensure_pipeline(self, lang_code: str = "a"):
        pipeline = self._pipelines.get(lang_code)
        if pipeline is not None:
            return pipeline
        try:
            from kokoro import KPipeline
        except ImportError:
            raise RuntimeError(
                "kokoro package not installed. Install with: pip install kokoro"
            )
        pipeline = KPipeline(lang_code=lang_code)
        self._pipelines[lang_code] = pipeline
        return pipeline

    def synthesize(
        self,
        text: str,
        *,
        voice_id: str = "af_heart",
        speed: float = 1.0,
        output_format: str = "wav",
    ) -> TTSResult:
        pipeline = self._ensure_pipeline(self._lang_for_voice(voice_id))
        import numpy as np
        import soundfile as sf

        samples = []
        for _, _, audio in pipeline(text, voice=voice_id, speed=speed):
            samples.append(audio)

        if not samples:
            return TTSResult(audio=b"", format=output_format, voice_id=voice_id)

        combined = np.concatenate(samples)
        buf = io.BytesIO()
        sf.write(buf, combined, 24000, format=output_format.upper())
        buf.seek(0)

        return TTSResult(
            audio=buf.read(),
            format=output_format,
            voice_id=voice_id,
            sample_rate=24000,
            duration_seconds=len(combined) / 24000,
            metadata={"backend": "kokoro"},
        )

    def available_voices(self) -> List[str]:
        return [
            # American English
            "af_heart", "af_bella", "am_adam", "am_michael",
            # British English (bm_* = British male — JARVIS-style)
            "bm_george", "bm_lewis", "bm_fable", "bm_daniel",
            "bf_emma", "bf_isabella",
        ]

    def health(self) -> bool:
        try:
            self._ensure_pipeline()
            return True
        except RuntimeError:
            return False
