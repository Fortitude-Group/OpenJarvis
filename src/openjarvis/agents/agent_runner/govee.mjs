// In-process MCP server for Govee lights (Govee developer API v1).
// The key comes from GOVEE_API_KEY and is only ever sent as a request header.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const API = "https://developer-api.govee.com/v1";
export const DEFAULT_DEVICE = process.env.GOVEE_DEVICE || "18:EC:C8:38:32:34:4A:15";

let cache = null;

async function govee(path, init = {}) {
  const key = process.env.GOVEE_API_KEY;
  if (!key) throw new Error("GOVEE_API_KEY is not set.");
  const res = await fetch(API + path, {
    ...init,
    headers: { "Govee-API-Key": key, "Content-Type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error("Govee rate limit hit (about 10 commands a minute per light). Wait a moment and retry.");
  if (!res.ok || (body.code && body.code !== 200)) throw new Error(`Govee said ${res.status}: ${body.message || "unknown error"}`);
  return body;
}

async function devices() {
  if (!cache) cache = (await govee("/devices")).data?.devices ?? [];
  return cache;
}

// Match by exact id, then by name ("office", "living room tv"). Empty -> default light.
export function resolveDevice(list, which) {
  const q = String(which || "").trim().toLowerCase();
  if (!q) return list.find((d) => d.device === DEFAULT_DEVICE) || list[0];
  return (
    list.find((d) => d.device.toLowerCase() === q) ||
    list.find((d) => d.deviceName.toLowerCase() === q) ||
    list.find((d) => d.deviceName.toLowerCase().includes(q)) ||
    list.find((d) => q.split(/\s+/).every((w) => d.deviceName.toLowerCase().includes(w)))
  );
}

async function pick(which) {
  const list = await devices();
  if (which === "all") return list;
  const d = resolveDevice(list, which);
  if (!d) throw new Error(`No light matches "${which}". Lights: ${list.map((x) => x.deviceName).join(", ")}.`);
  return [d];
}

export function buildCommand(action, a) {
  switch (action) {
    case "on": return { name: "turn", value: "on" };
    case "off": return { name: "turn", value: "off" };
    case "brightness": return { name: "brightness", value: Math.max(1, Math.min(100, Math.round(a.brightness ?? 100))) };
    case "color": return { name: "color", value: { r: a.r ?? 255, g: a.g ?? 255, b: a.b ?? 255 } };
    case "temperature": return { name: "colorTem", value: Math.max(2000, Math.min(9000, Math.round(a.kelvin ?? 4000))) };
    default: throw new Error(`Unknown action ${action}`);
  }
}

const ok = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (e) => ({ content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true });
const target = z.string().default("").describe('Light name or id, "all", or empty for the default (Office roof lights)');

export function createGoveeServer() {
  return createSdkMcpServer({
    name: "govee",
    version: "1.0.0",
    tools: [
      tool("list_lights", "List the user's Govee lights.", {}, async () => {
        try {
          const list = await devices();
          return ok(list.map((d) => `${d.deviceName} (${d.model}, ${d.device}${d.device === DEFAULT_DEVICE ? ", default" : ""})`).join("\n"));
        } catch (e) { return fail(e); }
      }),
      tool("light_state", "Read a light's power, brightness and colour.", { light: target }, async ({ light }) => {
        try {
          const [d] = await pick(light);
          const props = (await govee(`/devices/state?device=${encodeURIComponent(d.device)}&model=${encodeURIComponent(d.model)}`)).data?.properties ?? [];
          return ok(`${d.deviceName}: ${JSON.stringify(Object.assign({}, ...props))}`);
        } catch (e) { return fail(e); }
      }),
      tool(
        "control_light",
        "Turn Govee lights on or off, or set brightness (1-100), RGB colour, or white colour temperature (2000-9000K). Work out RGB values for named colours yourself.",
        {
          light: target,
          action: z.enum(["on", "off", "brightness", "color", "temperature"]),
          brightness: z.number().optional(),
          r: z.number().int().min(0).max(255).optional(),
          g: z.number().int().min(0).max(255).optional(),
          b: z.number().int().min(0).max(255).optional(),
          kelvin: z.number().optional(),
        },
        async (a) => {
          try {
            const cmd = buildCommand(a.action, a);
            const done = [];
            for (const d of await pick(a.light)) {
              await govee("/devices/control", { method: "PUT", body: JSON.stringify({ device: d.device, model: d.model, cmd }) });
              done.push(d.deviceName);
            }
            return ok(`${done.join(", ")}: ${cmd.name} ${JSON.stringify(cmd.value)}`);
          } catch (e) { return fail(e); }
        },
      ),
    ],
  });
}
