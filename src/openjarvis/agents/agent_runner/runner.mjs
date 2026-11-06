// Jarvis agent runner: carries out one spoken "do it" task with the Claude Agent SDK.
//
// Protocol (newline-delimited JSON):
//   stdin  line 1:  {task, context, resume, model}
//   stdin  later:   {type:"answer", id, allow} | {type:"cancel"}
//   stdout events:  {type:"say", text}            narration, spoken aloud
//                   {type:"step", text}           what tool is running, shown on screen
//                   {type:"ask", id, question, detail}   needs a yes/no from the user
//                   {type:"done", text, session_id, cost_usd}
//                   {type:"error", text}

import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createDesktopServer } from "./desktop.mjs";
import { createGoveeServer } from "./govee.mjs";
import { SYSTEM_APPEND, needsConfirmation, stepLabel } from "./policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const ASK_TIMEOUT_MS = 120_000;

const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const abort = new AbortController();
const pending = new Map();
let started = false;

function askUser(question, detail = "") {
  const id = randomUUID();
  emit({ type: "ask", id, question, detail });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(false); }, ASK_TIMEOUT_MS);
    pending.set(id, (allow) => { clearTimeout(timer); pending.delete(id); resolve(Boolean(allow)); });
  });
}

const jarvisServer = createSdkMcpServer({
  name: "jarvis",
  version: "1.0.0",
  tools: [
    tool(
      "confirm",
      "Ask the user a yes/no question out loud and wait for the answer. Use before anything irreversible or external, and to ask them to sign in to a site themselves.",
      { question: z.string().describe("Short spoken question, e.g. 'Shall I place the order for 24 pounds 99?'") },
      async ({ question }) => {
        const yes = await askUser(question);
        return { content: [{ type: "text", text: yes ? "The user said YES." : "The user said NO. Do not do it." }] };
      },
    ),
  ],
});

async function run(req) {
  const desktop = createDesktopServer();
  const options = {
    model: req.model || process.env.JARVIS_ACT_MODEL || "claude-opus-5-5",
    cwd: HOME,
    maxTurns: 80,
    abortController: abort,
    // Isolated from the user's own Claude Code settings, hooks and plugins.
    settingSources: [],
    permissionMode: "default",
    systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
    mcpServers: {
      jarvis: jarvisServer,
      desktop: desktop.server,
      govee: createGoveeServer(),
      browser: {
        type: "stdio",
        command: process.execPath,
        args: [
          path.join(HERE, "node_modules", "@playwright", "mcp", "cli.js"),
          "--browser", "chrome",
          "--user-data-dir", path.join(HOME, ".openjarvis", "browser-profile"),
        ],
      },
    },
    canUseTool: async (name, input) => {
      const gate = needsConfirmation(name, input);
      if (!gate) return { behavior: "allow", updatedInput: input };
      const yes = await askUser(gate.question, gate.detail);
      return yes
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "The user said no. Stop and tell them you did not do it." };
    },
  };
  if (req.resume) options.resume = req.resume;

  const prompt = req.context ? `${req.context}\n\nTask: ${req.task}` : req.task;
  // Text is held until a tool call follows it: then it was narration and is spoken.
  // The last text block is the final answer and arrives again in the result.
  let held = "";
  try {
    for await (const m of query({ prompt, options })) {
      if (m.type === "assistant") {
        for (const b of m.message?.content ?? []) {
          if (b.type === "text" && b.text.trim()) held = held ? `${held} ${b.text.trim()}` : b.text.trim();
          else if (b.type === "tool_use") {
            if (held) emit({ type: "say", text: held });
            held = "";
            emit({ type: "step", text: stepLabel(b.name, b.input) });
          }
        }
      } else if (m.type === "result") {
        const final = m.subtype === "success" ? (m.result || held) : `I stopped before finishing, sir (${m.subtype}).`;
        emit({ type: "done", text: final, session_id: m.session_id, cost_usd: m.total_cost_usd ?? null });
      }
    }
  } catch (err) {
    const msg = abort.signal.aborted ? "Cancelled." : (err?.message || String(err));
    emit({ type: abort.signal.aborted ? "done" : "error", text: msg });
  } finally {
    desktop.stop();
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!started) {
    started = true;
    run(msg).finally(() => process.exit(0));
  } else if (msg.type === "answer") {
    pending.get(msg.id)?.(msg.allow);
  } else if (msg.type === "cancel") {
    for (const resolve of pending.values()) resolve(false);
    abort.abort();
  }
});
