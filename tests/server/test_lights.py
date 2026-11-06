"""Tests for Govee light control (/v1/lights). A fake Govee API stands in."""

from __future__ import annotations

import pytest

pytest.importorskip("fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from openjarvis.server import govee  # noqa: E402
from openjarvis.server.govee import (  # noqa: E402
    GoveeClient,
    Light,
    LightsError,
    build_command,
    parse_colour,
    resolve,
)
from openjarvis.server.lights_routes import router  # noqa: E402

DEVICES = [
    {"device": "04:61", "model": "H6054", "deviceName": "Robs PC lights"},
    {"device": "23:BC", "model": "H6199", "deviceName": "Living room TV"},
    {
        "device": govee.DEFAULT_DEVICE,
        "model": "H61BE",
        "deviceName": "Office roof lights",
    },
]
LIGHTS = [Light(d["device"], d["model"], d["deviceName"]) for d in DEVICES]


class FakeGovee:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    def __call__(self, method, path, body):
        self.calls.append((method, path, body))
        if path == "/devices":
            return {"code": 200, "data": {"devices": DEVICES}}
        return {"code": 200, "message": "Success"}

    def controls(self):
        return [b for m, p, b in self.calls if p == "/devices/control"]


@pytest.fixture(autouse=True)
def _no_env_default(monkeypatch):
    monkeypatch.delenv("GOVEE_DEVICE", raising=False)
    monkeypatch.setattr(govee, "user_env_value", lambda n: "")


@pytest.mark.parametrize(
    "which,expected",
    [
        ("", "Office roof lights"),
        ("office", "Office roof lights"),
        ("the office lights", "Office roof lights"),
        ("tv", "Living room TV"),
        ("living room", "Living room TV"),
        ("pc", "Robs PC lights"),
        ("23:BC", "Living room TV"),
    ],
)
def test_resolve_by_name_part_or_id(which, expected):
    assert [li.name for li in resolve(LIGHTS, which)] == [expected]


def test_resolve_all_and_unknown():
    assert len(resolve(LIGHTS, "all")) == 3
    with pytest.raises(LightsError, match="I have Robs PC lights"):
        resolve(LIGHTS, "kitchen")


def test_default_light_follows_govee_device(monkeypatch):
    monkeypatch.setenv("GOVEE_DEVICE", "23:BC")
    assert resolve(LIGHTS, "")[0].name == "Living room TV"


def test_colours_whites_and_hex():
    assert parse_colour("Blue") == ("color", {"r": 0, "g": 0, "b": 255})
    assert parse_colour("warm white") == ("colorTem", 2700)
    assert parse_colour("#ff8000") == ("color", {"r": 255, "g": 128, "b": 0})
    with pytest.raises(LightsError, match="colour mauve-ish"):
        parse_colour("mauve-ish")


def test_commands_are_clamped():
    assert build_command("brightness", brightness=0)["value"] == 1
    assert build_command("brightness", brightness=150)["value"] == 100
    assert build_command("temperature", kelvin=500)["value"] == 2000
    assert build_command("off") == {"name": "turn", "value": "off"}


def test_control_sends_one_command_per_light_and_caches_devices():
    fake = FakeGovee()
    client = GoveeClient(send=fake)
    out = client.control("all", "off")
    client.control("tv", "color", color="red")
    assert len(fake.controls()) == 4
    assert sum(1 for c in fake.calls if c[1] == "/devices") == 1
    assert fake.controls()[-1] == {
        "device": "23:BC",
        "model": "H6199",
        "cmd": {"name": "color", "value": {"r": 255, "g": 0, "b": 0}},
    }
    assert out["message"] == "All the lights are off, sir."


def _app(fake: FakeGovee) -> TestClient:
    app = FastAPI()
    app.include_router(router)
    app.state.govee = GoveeClient(send=fake)
    return TestClient(app)


def test_route_controls_and_returns_spoken_message():
    fake = FakeGovee()
    r = _app(fake).post(
        "/v1/lights", json={"light": "office", "action": "brightness", "brightness": 20}
    )
    assert r.status_code == 200
    assert r.json()["message"] == "Office roof lights set to 20 percent, sir."
    assert fake.controls()[0]["cmd"] == {"name": "brightness", "value": 20}


def test_route_lists_lights():
    r = _app(FakeGovee()).get("/v1/lights")
    assert [li["name"] for li in r.json()["lights"]] == [
        d["deviceName"] for d in DEVICES
    ]


def test_route_user_errors_are_400_with_speakable_detail():
    r = _app(FakeGovee()).post("/v1/lights", json={"light": "garage", "action": "on"})
    assert r.status_code == 400 and "garage" in r.json()["detail"]


def test_route_refuses_foreign_origin_and_bad_action():
    fake = FakeGovee()
    client = _app(fake)
    r = client.post(
        "/v1/lights", json={"action": "on"}, headers={"Origin": "https://evil.example"}
    )
    assert r.status_code == 403
    assert client.post("/v1/lights", json={"action": "explode"}).status_code == 422
    assert fake.controls() == []


def test_spoken_message_grammar():
    from openjarvis.server.govee import describe

    on = {"name": "turn", "value": "on"}
    assert (
        describe(["Office roof lights"], "on", on, "")
        == "Office roof lights are on, sir."
    )
    assert describe(["Living room TV"], "on", on, "") == "Living room TV is on, sir."
