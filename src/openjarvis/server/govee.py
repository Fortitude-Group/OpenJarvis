"""Govee lights over the Govee developer API (v1).

Used by ``lights_routes`` so the HUD can switch lights straight from the local
model's ``control_lights`` tool call, without a round trip through the agent.
The API key comes from ``GOVEE_API_KEY`` and is only ever sent as a header.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx

from openjarvis.server.act_jobs import user_env_value

API = "https://developer-api.govee.com/v1"
DEFAULT_DEVICE = "18:EC:C8:38:32:34:4A:15"  # Office roof lights
DEVICE_CACHE_S = 600

COLOURS: Dict[str, Tuple[int, int, int]] = {
    "red": (255, 0, 0),
    "green": (0, 255, 0),
    "blue": (0, 0, 255),
    "white": (255, 255, 255),
    "yellow": (255, 210, 0),
    "orange": (255, 110, 0),
    "amber": (255, 150, 0),
    "purple": (140, 0, 255),
    "violet": (160, 60, 255),
    "magenta": (255, 0, 255),
    "pink": (255, 70, 160),
    "hot pink": (255, 20, 120),
    "cyan": (0, 255, 255),
    "turquoise": (0, 220, 180),
    "teal": (0, 160, 140),
    "lime": (150, 255, 0),
    "gold": (255, 180, 20),
    "lavender": (190, 140, 255),
    "indigo": (75, 0, 200),
    "crimson": (220, 20, 60),
    "aqua": (0, 255, 200),
    "sky blue": (90, 180, 255),
    "light blue": (120, 190, 255),
    "navy": (0, 0, 140),
    "dark blue": (0, 0, 160),
    "dark red": (150, 0, 0),
    "dark green": (0, 120, 0),
}
# Whites are better as colour temperature than as RGB.
WHITES: Dict[str, int] = {
    "warm white": 2700,
    "warm": 2700,
    "soft white": 3000,
    "candle": 2000,
    "neutral white": 4000,
    "natural white": 4000,
    "daylight": 6500,
    "cool white": 6500,
    "cool": 6500,
    "cold white": 9000,
}
ACTIONS = ("on", "off", "brightness", "color", "temperature")


class LightsError(Exception):
    """A request the user can fix (bad light name, unknown colour, rate limit)."""


@dataclass(frozen=True)
class Light:
    device: str
    model: str
    name: str


def api_key() -> str:
    return os.environ.get("GOVEE_API_KEY") or user_env_value("GOVEE_API_KEY")


def default_device() -> str:
    return (
        os.environ.get("GOVEE_DEVICE")
        or user_env_value("GOVEE_DEVICE")
        or DEFAULT_DEVICE
    )


def resolve(lights: List[Light], which: str) -> List[Light]:
    """Pick lights by id, name or part of a name ("office", "tv"); "all" = all."""
    q = (which or "").strip().lower()
    q = re.sub(r"\b(the|lights?|led|leds|strip)\b", " ", q).strip()
    if q in ("all", "every", "everything", "all of them"):
        return list(lights)
    if not q:
        dflt = default_device()
        return [next((li for li in lights if li.device == dflt), lights[0])]
    for test in (
        lambda li: li.device.lower() == q,
        lambda li: li.name.lower() == q,
        lambda li: q in li.name.lower(),
        lambda li: all(w in li.name.lower() for w in q.split()),
    ):
        hits = [li for li in lights if test(li)]
        if hits:
            return hits[:1]
    names = ", ".join(li.name for li in lights)
    raise LightsError(f"I don't have a light called {which}. I have {names}.")


def parse_colour(colour: str) -> Tuple[str, Any]:
    """Return ("color", {r,g,b}) or ("colorTem", kelvin) for a name or #hex."""
    c = (colour or "").strip().lower()
    if c in WHITES:
        return "colorTem", WHITES[c]
    if c in COLOURS:
        r, g, b = COLOURS[c]
        return "color", {"r": r, "g": g, "b": b}
    m = re.fullmatch(r"#?([0-9a-f]{6})", c)
    if m:
        v = int(m.group(1), 16)
        return "color", {"r": v >> 16, "g": (v >> 8) & 255, "b": v & 255}
    raise LightsError(f"I don't know the colour {colour}.")


def build_command(
    action: str,
    brightness: Optional[int] = None,
    color: str = "",
    kelvin: Optional[int] = None,
) -> Dict[str, Any]:
    if action == "on":
        return {"name": "turn", "value": "on"}
    if action == "off":
        return {"name": "turn", "value": "off"}
    if action == "brightness":
        return {
            "name": "brightness",
            "value": max(1, min(100, int(100 if brightness is None else brightness))),
        }
    if action == "temperature":
        return {
            "name": "colorTem",
            "value": max(2000, min(9000, int(4000 if kelvin is None else kelvin))),
        }
    if action == "color":
        name, value = parse_colour(color)
        return {"name": name, "value": value}
    raise LightsError(f"Unknown light action {action}.")


def describe(names: List[str], action: str, cmd: Dict[str, Any], color: str) -> str:
    who = " and ".join(names) if len(names) < 3 else "All the lights"
    if action in ("on", "off"):
        plural = len(names) > 1 or who.lower().endswith(("lights", "leds", "strips"))
        return f"{who} {'are' if plural else 'is'} {action}, sir."
    if action == "brightness":
        return f"{who} set to {cmd['value']} percent, sir."
    if action == "color" and color:
        return f"{who} set to {color.strip().lower()}, sir."
    return f"{who} set to {cmd['value']} kelvin, sir."


Sender = Callable[[str, str, Optional[dict]], dict]


class GoveeClient:
    def __init__(self, send: Optional[Sender] = None) -> None:
        self._send = send or self._http
        self._lights: List[Light] = []
        self._fetched = 0.0

    @staticmethod
    def _http(method: str, path: str, body: Optional[dict]) -> dict:
        key = api_key()
        if not key:
            raise LightsError("GOVEE_API_KEY isn't set, so I can't reach the lights.")
        r = httpx.request(
            method,
            API + path,
            json=body,
            timeout=10,
            headers={"Govee-API-Key": key},
        )
        if r.status_code == 429:
            raise LightsError("Govee is rate limiting me. Give it a minute, sir.")
        data = r.json() if r.content else {}
        if r.status_code != 200 or data.get("code", 200) != 200:
            msg = data.get("message") or r.reason_phrase
            raise LightsError(f"Govee said: {msg}.")
        return data

    def lights(self) -> List[Light]:
        if not self._lights or time.time() - self._fetched > DEVICE_CACHE_S:
            devices = self._send("GET", "/devices", None).get("data", {})
            self._lights = [
                Light(d["device"], d["model"], d.get("deviceName") or d["device"])
                for d in devices.get("devices", [])
            ]
            self._fetched = time.time()
        if not self._lights:
            raise LightsError("Govee says you have no lights on this account.")
        return self._lights

    def control(
        self,
        light: str = "",
        action: str = "on",
        brightness: Optional[int] = None,
        color: str = "",
        kelvin: Optional[int] = None,
    ) -> Dict[str, Any]:
        cmd = build_command(action, brightness, color, kelvin)
        targets = resolve(self.lights(), light)
        for t in targets:
            self._send(
                "PUT",
                "/devices/control",
                {"device": t.device, "model": t.model, "cmd": cmd},
            )
        names = [t.name for t in targets]
        return {
            "lights": names,
            "cmd": cmd,
            "message": describe(names, action, cmd, color),
        }
