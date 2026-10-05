import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { app } from "electron";
import { IPC_CHANNELS, type IpcChannel, type McpClientId, type McpStatusView } from "../shared/munhae-api";
import { MCP_PATH, MCP_PORT, MCP_SERVER_NAME } from "../shared/mcp-tools";
import { resolveAgentExecutable } from "./agent-runtime-client";
import { AppError } from "./errors";
import { log } from "./log";
import { listMcpChanges, setEditingDocument, undoMcpChange } from "./mcp-changes";
import { callMcpTool } from "./mcp-handlers";
import { createMcpServer } from "./mcp-server";
import { mainDir } from "./paths";
import { getCurrentSummary } from "./session";

export const MCP_CHANNELS: readonly IpcChannel[] = [IPC_CHANNELS.mcpStatus, IPC_CHANNELS.mcpConnect, IPC_CHANNELS.mcpDisconnect, IPC_CHANNELS.mcpUndo, IPC_CHANNELS.mcpList, IPC_CHANNELS.mcpReportEditing];

let server: ReturnType<typeof createMcpServer> | null = null;
let serverState: McpStatusView["server"]["state"] = "stopped";

/**
 * Like Paper, the server is open whenever the app runs. AI tools launch a relay command
 * in the home folder, which this rewrites on every launch so app updates or moves never
 * break a registration.
 */
export function startMcpServer(): void {
  if (server) return;
  try { writeLauncher(); } catch (error) { log.warn("mcp relay command not written", { message: error instanceof Error ? error.message : "unknown" }); }
  const next = createMcpServer({ callTool: callMcpTool, version: app.getVersion() });
  server = next;
  next.listen().then(
    (port) => { serverState = "running"; log.info("mcp server ready", { port }); },
    (error: NodeJS.ErrnoException) => {
      serverState = error.code === "EADDRINUSE" ? "port_in_use" : "failed";
      if (server === next) server = null;
      log.warn("mcp server not started", { code: error.code ?? "unknown" });
    },
  );
}

export async function stopMcpServer(): Promise<void> {
  const active = server;
  server = null;
  serverState = "stopped";
  await active?.close();
}

export function launcherPath(): string {
  return join(homedir(), ".munhae", "bin", process.platform === "win32" ? "munhae-mcp.cmd" : "munhae-mcp");
}

function launcherScript(): string {
  const relay = join(mainDir, "mcp-relay.js");
  if (process.platform === "win32") {
    return `@echo off\r\nrem Written by Munhae Studio on each launch.\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${relay}" %*\r\n`;
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/sh\n# Written by Munhae Studio on each launch. Runs the app's MCP relay with the app's own runtime.\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(relay)} "$@"\n`;
}

function writeLauncher(): void {
  const path = launcherPath();
  const script = launcherScript();
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== script) writeFileSync(path, script, { encoding: "utf8", mode: 0o755 });
  if (process.platform !== "win32") chmodSync(path, 0o755);
}

type Client = {
  label: string;
  add(command: string): string[];
  remove: string[];
  /** The registered command, read from the tool's own settings file without changing it. */
  registered(): string | null;
};

const readJson = (path: string): Record<string, unknown> | null => {
  try { return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { return null; }
};
const serverEntry = (config: Record<string, unknown> | null): string | null => {
  const servers = config?.mcpServers;
  if (!servers || typeof servers !== "object") return null;
  const entry = (servers as Record<string, unknown>)[MCP_SERVER_NAME];
  if (!entry || typeof entry !== "object") return null;
  const command = (entry as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
};

const CLIENTS: Record<McpClientId, Client> = {
  claude: {
    label: "Claude Code",
    add: (command) => ["mcp", "add", "--scope", "user", MCP_SERVER_NAME, "--", command],
    remove: ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME],
    registered: () => serverEntry(readJson(join(homedir(), ".claude.json"))),
  },
  codex: {
    label: "Codex",
    add: (command) => ["mcp", "add", MCP_SERVER_NAME, "--", command],
    remove: ["mcp", "remove", MCP_SERVER_NAME],
    registered: () => {
      let text = "";
      try { text = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8"); } catch { return null; }
      const section = text.match(new RegExp(`^\\[mcp_servers\\.${MCP_SERVER_NAME}\\]\\s*$([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, "m"));
      if (!section) return null;
      return section[1]!.match(/^command\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1]?.replace(/\\(.)/g, "$1") ?? "";
    },
  },
  antigravity: {
    label: "Antigravity",
    add: (command) => ["mcp", "add", MCP_SERVER_NAME, command],
    remove: ["mcp", "remove", MCP_SERVER_NAME],
    registered: () => serverEntry(readJson(join(homedir(), ".gemini", "antigravity", "mcp_config.json")))
      ?? serverEntry(readJson(join(homedir(), ".gemini", "config", "mcp_config.json"))),
  },
};

function run(binary: string, args: string[]): Promise<void> {
  // npm-installed CLIs start with `#!/usr/bin/env node`; their own folder holds that node.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: [dirname(binary), process.env.PATH ?? ""].filter(Boolean).join(delimiter) };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, timeout: 30_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim().split("\n").slice(-1)[0] || "명령을 실행하지 못했습니다."), { code: "mcp_register_failed" }));
      else resolve();
    });
  });
}

async function clientStatus(id: McpClientId): Promise<McpStatusView["clients"][number]> {
  const client = CLIENTS[id];
  const binary = await resolveAgentExecutable(id).catch(() => null);
  const registered = client.registered();
  const connected = registered === launcherPath();
  const detail = !binary && !connected ? "CLI가 설치되어 있지 않습니다."
    : registered !== null && !connected ? "다른 명령으로 등록되어 있습니다. 다시 연결하면 문해 명령으로 바꿉니다."
      : null;
  return { id, label: client.label, installed: !!binary, connected, detail };
}

export async function mcpStatus(): Promise<McpStatusView> {
  return {
    server: { state: serverState, url: `http://127.0.0.1:${MCP_PORT}${MCP_PATH}` },
    command: launcherPath(),
    sessions: [...(server?.sessions.values() ?? [])]
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(session => ({ label: session.label, lastSeenAt: session.lastSeenAt })),
    clients: await Promise.all((Object.keys(CLIENTS) as McpClientId[]).map(clientStatus)),
  };
}

function parseClient(value: unknown): McpClientId {
  if (value === "claude" || value === "codex" || value === "antigravity") return value;
  throw new AppError("invalid_input", "연결할 AI 도구를 확인하세요.");
}

async function connect(id: McpClientId): Promise<void> {
  const binary = await resolveAgentExecutable(id);
  if (!binary) throw new AppError("cli_not_found", `${CLIENTS[id].label} CLI를 찾지 못했습니다.`);
  writeLauncher();
  // Replacing an older or foreign entry needs a remove first; a missing entry is fine.
  if (CLIENTS[id].registered() !== null) await run(binary, CLIENTS[id].remove).catch(() => undefined);
  await run(binary, CLIENTS[id].add(launcherPath()));
}

async function disconnect(id: McpClientId): Promise<void> {
  const binary = await resolveAgentExecutable(id);
  if (!binary) throw new AppError("cli_not_found", `${CLIENTS[id].label} CLI를 찾지 못했습니다.`);
  await run(binary, CLIENTS[id].remove);
}

export async function dispatchMcp(channel: IpcChannel, input: unknown): Promise<unknown> {
  switch (channel) {
    case IPC_CHANNELS.mcpUndo:
      if (typeof input !== "string" || !input || input.length > 64) throw new AppError("invalid_input", "되돌릴 변경을 확인하세요.");
      return undoMcpChange(input);
    case IPC_CHANNELS.mcpReportEditing: setEditingDocument(input); return undefined;
    case IPC_CHANNELS.mcpList: {
      const projectId = getCurrentSummary()?.projectId;
      return projectId ? listMcpChanges(projectId) : [];
    }
    case IPC_CHANNELS.mcpConnect: await connect(parseClient(input)); break;
    case IPC_CHANNELS.mcpDisconnect: await disconnect(parseClient(input)); break;
    case IPC_CHANNELS.mcpStatus: break;
    default: throw new AppError("invalid_input", "지원하지 않는 요청입니다.");
  }
  return mcpStatus();
}
