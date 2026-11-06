"""Light control for the HUD.

    GET  /v1/lights   -> {lights: [{name, device, model}]}
    POST /v1/lights   {light?, action, brightness?, color?, kelvin?}
                      -> {lights, cmd, message}   (message is ready to speak)

Errors the user can fix come back as 400 with a spoken-style ``detail``.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from openjarvis.server.act_routes import require_local_client
from openjarvis.server.govee import GoveeClient, LightsError


class LightRequest(BaseModel):
    light: str = Field(default="", max_length=80)
    action: Literal["on", "off", "brightness", "color", "temperature"]
    brightness: Optional[int] = Field(default=None, ge=0, le=100)
    color: str = Field(default="", max_length=40)
    kelvin: Optional[int] = Field(default=None, ge=1000, le=10000)


def _client(request: Request) -> GoveeClient:
    client = getattr(request.app.state, "govee", None)
    if client is None:
        client = GoveeClient()
        request.app.state.govee = client
    return client


router = APIRouter(prefix="/v1/lights", tags=["lights"])


@router.get("")
async def list_lights(request: Request) -> dict:
    require_local_client(request, body=False)
    try:
        lights = await run_in_threadpool(_client(request).lights)
    except LightsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"lights": [vars(li) for li in lights]}


@router.post("")
async def control_lights(payload: LightRequest, request: Request) -> dict:
    require_local_client(request, body=True)
    try:
        return await run_in_threadpool(
            _client(request).control,
            payload.light,
            payload.action,
            payload.brightness,
            payload.color,
            payload.kelvin,
        )
    except LightsError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # network trouble talking to Govee
        raise HTTPException(status_code=502, detail=f"I couldn't reach Govee: {e}")
