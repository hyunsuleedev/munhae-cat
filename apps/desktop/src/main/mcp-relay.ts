// stdio MCP relay that AI tools launch through ~/.munhae/bin/munhae-mcp.
// It forwards each JSON-RPC message to the running app's local MCP server and,
// while Munhae is closed, still lists the tools and answers that the app must be opened.
import { request } from "node:http";
import { createInterface } from "node:readline";
import {
  MCP_APP_NOT_RUNNING,
  MCP_DEFAULT_PROTOCOL,
  MCP_INSTRUCTIONS,
  MCP_PATH,
  MCP_PORT,
  MCP_SERVER_NAME,
  MCP_SUPPORTED_PROTOCOLS,
  MCP_TOOLS,
} from "../shared/mcp-tools";

type Message = Record<string, unknown>;
type Reply = { status: number; sessionId: string | null; body: string };

const port = Number(process.env.MUNHAE_MCP_PORT) || MCP_PORT;
let initializeParams: unknown = null;
let sessionId: string | null = null;
let upstream = false;

function post(message: unknown): Promise<Reply> {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return new Promise((resolve, reject) => {
    const call = request({
      host: "127.0.0.1",
      port,
      path: MCP_PATH,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": body.byteLength,
        accept: "application/json, text/event-stream",
        "x-munhae-from": "relay",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      timeout: 120_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.on("end", () => {
        const header = response.headers["mcp-session-id"];
        resolve({ status: response.statusCode ?? 500, sessionId: typeof header === "string" ? header : null, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    call.once("timeout", () => call.destroy(new Error("timeout")));
    call.once("error", reject);
    call.end(body);
  });
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Opens an app session with the client's own initialize parameters, e.g. after Munhae (re)starts. */
async function connect(): Promise<boolean> {
  if (upstream) return true;
  if (initializeParams === null) return false;
  try {
    sessionId = null;
    const reply = await post({ jsonrpc: "2.0", id: "munhae-relay-initialize", method: "initialize", params: initializeParams });
    if (reply.status !== 200) return false;
    sessionId = reply.sessionId;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    upstream = true;
    return true;
  } catch {
    return false;
  }
}

function offline(message: Message): unknown {
  const id = message.id;
  if (id === undefined) return null;
  switch (message.method) {
    case "initialize": {
      const params = typeof message.params === "object" && message.params ? message.params as Message : {};
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return { jsonrpc: "2.0", id, result: {
        protocolVersion: (MCP_SUPPORTED_PROTOCOLS as readonly string[]).includes(requested) ? requested : MCP_DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, title: "문해 Munhae Studio", version: "relay" },
        instructions: MCP_INSTRUCTIONS,
      } };
    }
    case "ping": return { jsonrpc: "2.0", id, result: {} };
    case "tools/list": return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: MCP_APP_NOT_RUNNING }], isError: true } };
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message.method).slice(0, 80)}` } };
  }
}

async function relay(message: Message): Promise<void> {
  if (message.method === "initialize") {
    initializeParams = message.params ?? {};
    upstream = false;
    sessionId = null;
    try {
      const reply = await post(message);
      if (reply.status === 200) {
        sessionId = reply.sessionId;
        process.stdout.write(`${reply.body}\n`);
        return;
      }
    } catch {
      // Munhae is closed; answer locally and connect on a later call.
    }
    write(offline(message));
    return;
  }
  if (message.method === "notifications/initialized") {
    // Only meaningful for an app session opened by the client's own initialize.
    if (sessionId) {
      try { await post(message); upstream = true; } catch { upstream = false; }
    }
    return;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await connect())) break;
    try {
      const reply = await post(message);
      if (reply.status === 404) { upstream = false; continue; }
      if (reply.status === 202 || !reply.body.trim()) return;
      process.stdout.write(`${reply.body}\n`);
      return;
    } catch {
      upstream = false;
    }
  }
  const answer = offline(message);
  if (answer) write(answer);
}

let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const messages = Array.isArray(message) ? message : [message];
  for (const item of messages) {
    if (typeof item !== "object" || item === null) continue;
    queue = queue.then(() => relay(item as Message)).catch(() => undefined);
  }
});
/** Ends this conversation's app session so the settings page counts only open conversations. */
function closeSession(): Promise<void> {
  if (!sessionId) return Promise.resolve();
  return new Promise((resolve) => {
    const call = request({ host: "127.0.0.1", port, path: MCP_PATH, method: "DELETE", headers: { "mcp-session-id": sessionId!, "x-munhae-from": "relay" }, timeout: 2_000 }, (response) => {
      response.resume();
      response.on("end", () => resolve());
    });
    call.once("timeout", () => call.destroy());
    call.once("error", () => resolve());
    call.end();
  });
}

lines.on("close", () => { void queue.then(closeSession).then(() => process.exit(0)); });
