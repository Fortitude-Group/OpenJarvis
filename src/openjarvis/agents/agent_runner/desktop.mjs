// In-process MCP server that lets the agent see and drive the Windows desktop.
// All the Win32 work happens in desktop.ps1, kept alive as one child process.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_WIDTH = 1568;

class DesktopHelper {
  constructor() {
    this.proc = null;
    this.queue = [];
    // Last screenshot geometry, used to map screenshot coords back to the screen.
    this.geo = null;
  }

  start() {
    if (this.proc) return;
    this.proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(HERE, "desktop.ps1")],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const waiter = this.queue.shift();
      if (!waiter) return;
      try { waiter.resolve(JSON.parse(line)); } catch { waiter.resolve({ ok: false, error: line }); }
    });
    this.proc.stderr.on("data", (d) => process.stderr.write(`[desktop] ${d}`));
    this.proc.on("exit", () => {
      for (const w of this.queue.splice(0)) w.resolve({ ok: false, error: "desktop helper exited" });
      this.proc = null;
    });
  }

  call(cmd) {
    this.start();
    return new Promise((resolve) => {
      this.queue.push({ resolve });
      this.proc.stdin.write(JSON.stringify(cmd) + "\n");
    });
  }

  toScreen(x, y) {
    if (!this.geo) throw new Error("Take a screenshot first so coordinates can be mapped.");
    const { x0, y0, w, h, sw, sh } = this.geo;
    return { x: Math.round(x0 + (x * w) / sw), y: Math.round(y0 + (y * h) / sh) };
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

const helper = new DesktopHelper();
const text = (t) => ({ content: [{ type: "text", text: t }] });
const result = (r, okText) => (r.ok ? text(okText) : { ...text(`Failed: ${r.error}`), isError: true });

async function screenshot({ monitor = -1 } = {}) {
  const r = await helper.call({ op: "screenshot", monitor, max: MAX_WIDTH });
  if (!r.ok) return result(r);
  helper.geo = r;
  const data = (await readFile(r.path)).toString("base64");
  return {
    content: [
      { type: "image", data, mimeType: "image/png" },
      { type: "text", text: `Monitor ${r.monitor} screenshot, ${r.sw}x${r.sh} (monitor is ${r.w}x${r.h}). Click/scroll coordinates refer to THIS screenshot. Monitors: ${monitorList(r.monitors)}.` },
    ],
  };
}

const monitorList = (ms = []) =>
  ms.map((m) => `${m.index}${m.primary ? " (primary)" : ""} ${m.w}x${m.h}`).join(", ");

const xy = { x: z.number().describe("x in screenshot pixels"), y: z.number().describe("y in screenshot pixels") };

export function createDesktopServer() {
  const server = createSdkMcpServer({
    name: "desktop",
    version: "1.0.0",
    tools: [
      tool(
        "screenshot",
        "Capture one monitor (the primary by default). Take one before clicking, and again afterwards to check the result. Clicks map onto the monitor of the latest screenshot.",
        { monitor: z.number().int().default(-1).describe("monitor index from the list in a previous result; -1 = primary") },
        screenshot,
      ),
      tool(
        "click",
        "Click at a point on the latest screenshot.",
        { ...xy, button: z.enum(["left", "right", "middle"]).default("left"), double: z.boolean().default(false) },
        async (a) => {
          const p = helper.toScreen(a.x, a.y);
          return result(await helper.call({ op: "click", ...p, button: a.button, double: a.double }), `Clicked ${a.button} at ${a.x},${a.y}.`);
        },
      ),
      tool("move", "Move the mouse to a point on the latest screenshot.", xy, async (a) => {
        const p = helper.toScreen(a.x, a.y);
        return result(await helper.call({ op: "move", ...p }), "Moved.");
      }),
      tool(
        "scroll",
        "Scroll the mouse wheel at a point. Negative amount scrolls down, positive up (in notches).",
        { ...xy, amount: z.number().int() },
        async (a) => {
          const p = helper.toScreen(a.x, a.y);
          return result(await helper.call({ op: "scroll", ...p, amount: a.amount }), "Scrolled.");
        },
      ),
      tool("type_text", "Type text into whatever has keyboard focus. Any Unicode text.", { text: z.string() }, async (a) =>
        result(await helper.call({ op: "type", text: a.text }), "Typed."),
      ),
      tool(
        "press_keys",
        "Press keys or shortcuts, e.g. 'enter', 'ctrl+c', 'win+d', 'alt+tab', 'volumedown volumedown volumedown', 'playpause', 'mute'. Space separates successive presses, + makes a chord.",
        { keys: z.string() },
        async (a) => result(await helper.call({ op: "key", keys: a.keys }), `Pressed ${a.keys}.`),
      ),
    ],
  });
  return { server, stop: () => helper.stop() };
}
