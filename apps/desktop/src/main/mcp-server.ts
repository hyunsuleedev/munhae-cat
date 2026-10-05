import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  MCP_DEFAULT_PROTOCOL,
  MCP_INSTRUCTIONS,
  MCP_PATH,
  MCP_PORT,
  MCP_SERVER_NAME,
  MCP_SUPPORTED_PROTOCOLS,
  MCP_TOOLS,
  mcpClientLabel,
} from "../shared/mcp-tools";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type McpSession = {
  id: string;
  label: string;
  via: "relay" | "http";
  createdAt: string;
  lastSeenAt: string;
};

/** A tool answer the model should read. `stop` tells it to report to the user instead of working around it. */
export class McpToolError extends Error {
  constructor(readonly code: string, message: string, readonly stop = false) {
    super(message);
    this.name = "McpToolError";
  }
}

export type McpCallTool = (name: string, args: Record<string, unknown>, session: McpSession) => unknown;

type JsonRpcId = string | number;
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId | null; result?: unknown; error?: { code: number; message: string } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is JsonRpcId => typeof value === "string" || typeof value === "number";

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request too large"), { code: "request_too_large" });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

function toolError(error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  const code = error instanceof McpToolError ? error.code
    : isRecord(error) && typeof error.code === "string" && /^[a-z_]{1,64}$/u.test(error.code) ? error.code : "internal";
  const message = error instanceof Error && code !== "internal" ? error.message.slice(0, 500) : "문해에서 요청을 처리하지 못했습니다.";
  const stop = error instanceof McpToolError ? error.stop : code === "internal";
  const guide = stop ? " 다른 방법으로 해결하려 하지 말고 이 내용을 사용자에게 알리세요." : "";
  return { content: [{ type: "text", text: `[${code}] ${message}${guide}` }], isError: true };
}

export function createMcpServer(options: { callTool: McpCallTool; version: string; port?: number }) {
  const sessions = new Map<string, McpSession>();
  const port = options.port ?? MCP_PORT;
  let server: Server | null = null;
  let boundPort = port;

  const openSession = (id: string, clientInfo: unknown, via: McpSession["via"]): McpSession => {
    const now = new Date().toISOString();
    const session = { id, label: mcpClientLabel(isRecord(clientInfo) ? clientInfo : null), via, createdAt: now, lastSeenAt: now };
    sessions.set(id, session);
    return session;
  };

  async function handleMessage(message: unknown, session: McpSession): Promise<JsonRpcResponse | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    // Responses and notifications need no reply; this server sends no requests of its own.
    if (typeof message.method !== "string") return null;
    if (!isId(message.id)) return null;
    const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id: message.id as JsonRpcId, result });
    const fail = (code: number, text: string): JsonRpcResponse => ({ jsonrpc: "2.0", id: message.id as JsonRpcId, error: { code, message: text } });
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return reply({
          protocolVersion: (MCP_SUPPORTED_PROTOCOLS as readonly string[]).includes(requested) ? requested : MCP_DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "문해 Munhae Studio", version: options.version },
          instructions: MCP_INSTRUCTIONS,
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: MCP_TOOLS });
      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        if (!MCP_TOOLS.some(tool => tool.name === name)) return fail(-32602, `Unknown tool: ${name.slice(0, 80)}`);
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isRecord(args)) return reply(toolError(new McpToolError("invalid_input", "도구 인자는 JSON 객체여야 합니다.")));
        try {
          const result = await options.callTool(name, args, session);
          return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (error) {
          return reply(toolError(error));
        }
      }
      default: return fail(-32601, `Method not found: ${message.method.slice(0, 80)}`);
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: "not_found" });
    // Same guard as Paper: no browser pages, and no DNS-rebinding hosts.
    if (req.headers.origin !== undefined || req.method === "OPTIONS") return sendJson(res, 403, { error: "forbidden", error_description: "Browser requests not allowed" });
    const hosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (req.headers.host && !hosts.includes(req.headers.host)) return sendJson(res, 403, { error: "forbidden", error_description: "Invalid host" });

    const headerId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
    if (req.method === "DELETE") {
      if (headerId) sessions.delete(headerId);
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (error) {
      const tooLarge = isRecord(error) && error.code === "request_too_large";
      return sendJson(res, tooLarge ? 413 : 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: tooLarge ? "Request too large" : "Parse error" } });
    }
    const messages = Array.isArray(payload) ? payload : [payload];
    const via = req.headers["x-munhae-from"] === "relay" ? "relay" : "http";
    const initialize = messages.find(message => isRecord(message) && message.method === "initialize");
    // A session outlives neither the app nor its sessions map. After a restart the client keeps
    // its old ID; accept it as a fresh session instead of failing every call with 404.
    const session = initialize && isRecord(initialize)
      ? openSession(randomUUID(), isRecord(initialize.params) ? initialize.params.clientInfo : null, via)
      : sessions.get(headerId ?? "") ?? openSession(headerId ?? randomUUID(), null, via);
    session.lastSeenAt = new Date().toISOString();

    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await handleMessage(message, session);
      if (response) responses.push(response);
    }
    const headers: Record<string, string> = initialize ? { "mcp-session-id": session.id } : {};
    if (!responses.length) {
      res.writeHead(202, headers).end();
      return;
    }
    sendJson(res, 200, Array.isArray(payload) ? responses : responses[0], headers);
  }

  return {
    sessions,
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        const next = createServer((req, res) => {
          void handle(req, res).catch(() => {
            if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
            else res.destroy();
          });
        });
        next.once("error", reject);
        next.listen(port, "127.0.0.1", () => {
          const address = next.address();
          boundPort = typeof address === "object" && address ? address.port : port;
          server = next;
          resolve(boundPort);
        });
      });
    },
    close(): Promise<void> {
      const active = server;
      server = null;
      sessions.clear();
      return new Promise(resolve => (active ? active.close(() => resolve()) : resolve()));
    },
  };
}
