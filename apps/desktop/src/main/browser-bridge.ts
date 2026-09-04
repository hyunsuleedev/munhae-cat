import { app } from "electron";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { IPC_CHANNELS, type IpcChannel, type IpcResult } from "../shared/munhae-api";
import { probeAgentsCached } from "./agents";
import { errorCode } from "./errors";
import {
  parseConfirmInput,
  parseContextPreviewInput,
  parseCreateDocumentInput,
  parseCreateFromPasteInput,
  parseCreateProjectInput,
  parseDocumentNodeId,
  parseGlossaryInput,
  parseMergeBlocksInput,
  parseOptionalPath,
  parsePersonInput,
  parsePlaceInput,
  parseSaveDraftInput,
  parseSplitBlockInput,
  parseStage,
} from "./ipc-validate";
import { log, redact } from "./log";
import { openHttpsExternal } from "./security";
import {
  backupProject,
  closeProject,
  createFromPaste,
  createProjectInteractive,
  getAppConfig,
  getCurrentSummary,
  getHome,
  listRecent,
  openProjectInteractive,
  pickTextFile,
  requireRepo,
  seedDemo,
  setAppConfig,
} from "./session";

export const BROWSER_BRIDGE_PORT = 17321;
const BODY_LIMIT = 22_000_000;
const ALLOWED_CHANNELS = new Set<IpcChannel>([
  IPC_CHANNELS.appGetVersion,
  IPC_CHANNELS.appGetConfig,
  IPC_CHANNELS.appSetConfig,
  IPC_CHANNELS.appProbeAgents,
  IPC_CHANNELS.appQuit,
  IPC_CHANNELS.appOpenExternal,
  IPC_CHANNELS.projectCreate,
  IPC_CHANNELS.projectOpen,
  IPC_CHANNELS.projectClose,
  IPC_CHANNELS.projectGetCurrent,
  IPC_CHANNELS.projectListRecent,
  IPC_CHANNELS.projectBackup,
  IPC_CHANNELS.projectCreateFromPaste,
  IPC_CHANNELS.projectSeedDemo,
  IPC_CHANNELS.homeGet,
  IPC_CHANNELS.documentCreate,
  IPC_CHANNELS.documentPickText,
  IPC_CHANNELS.editorGet,
  IPC_CHANNELS.editorSaveDraft,
  IPC_CHANNELS.editorConfirm,
  IPC_CHANNELS.editorRevise,
  IPC_CHANNELS.editorMergeBlocks,
  IPC_CHANNELS.editorSplitBlock,
  IPC_CHANNELS.knowledgeGet,
  IPC_CHANNELS.knowledgeUpsertGlossary,
  IPC_CHANNELS.knowledgeUpsertPerson,
  IPC_CHANNELS.knowledgeUpsertPlace,
  IPC_CHANNELS.contextPreview,
]);

let server: Server | null = null;

function rendererOrigin(): string | null {
  const value = process.env.ELECTRON_RENDERER_URL;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown, origin: string): void {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  });
  res.end(JSON.stringify(value));
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  const safe = redact(raw);
  return safe.length > 400 ? `${safe.slice(0, 400)}…` : safe;
}

function toResultError(error: unknown): IpcResult<never> {
  return { ok: false, error: { code: errorCode(error), message: safeMessage(error) } };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function dispatch(channel: IpcChannel, args: unknown[]): Promise<unknown> {
  switch (channel) {
    case IPC_CHANNELS.appGetVersion: return app.getVersion();
    case IPC_CHANNELS.appGetConfig: return getAppConfig();
    case IPC_CHANNELS.appSetConfig: return setAppConfig(args[0]);
    case IPC_CHANNELS.appProbeAgents: return probeAgentsCached();
    case IPC_CHANNELS.appQuit:
      setImmediate(() => app.quit());
      return undefined;
    case IPC_CHANNELS.appOpenExternal:
      if (typeof args[0] !== "string") throw new Error("https 주소만 열 수 있습니다.");
      return openHttpsExternal(args[0]);
    case IPC_CHANNELS.projectGetCurrent: return getCurrentSummary();
    case IPC_CHANNELS.projectListRecent: return listRecent();
    case IPC_CHANNELS.projectCreate: return wrap(() => createProjectInteractive(parseCreateProjectInput(args[0])));
    case IPC_CHANNELS.projectOpen: return wrap(() => openProjectInteractive(parseOptionalPath(args[0])));
    case IPC_CHANNELS.projectClose: return wrap(() => closeProject());
    case IPC_CHANNELS.projectBackup: return wrap(() => backupProject());
    case IPC_CHANNELS.projectCreateFromPaste: return wrap(() => createFromPaste(parseCreateFromPasteInput(args[0])));
    case IPC_CHANNELS.projectSeedDemo: return wrap(() => seedDemo());
    case IPC_CHANNELS.homeGet: return wrap(() => getHome());
    case IPC_CHANNELS.documentCreate: return wrap(() => requireRepo().createDocument(parseCreateDocumentInput(args[0])));
    case IPC_CHANNELS.documentPickText: return wrap(() => pickTextFile());
    case IPC_CHANNELS.editorGet: return wrap(() => requireRepo().getEditor(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.editorSaveDraft: return wrap(() => requireRepo().saveTranslationDraft(parseSaveDraftInput(args[0])));
    case IPC_CHANNELS.editorConfirm: return wrap(() => requireRepo().confirmTranslation(parseConfirmInput(args[0])));
    case IPC_CHANNELS.editorRevise:
      return wrap(() => requireRepo().reviseTranslation(parseDocumentNodeId(args[0]), parseStage(args[1])));
    case IPC_CHANNELS.editorMergeBlocks: return wrap(() => requireRepo().mergeBlocks(parseMergeBlocksInput(args[0])));
    case IPC_CHANNELS.editorSplitBlock: return wrap(() => requireRepo().splitBlock(parseSplitBlockInput(args[0])));
    case IPC_CHANNELS.knowledgeGet: return wrap(() => requireRepo().getKnowledge());
    case IPC_CHANNELS.knowledgeUpsertGlossary:
      return wrap(() => requireRepo().upsertGlossary(parseGlossaryInput(args[0])));
    case IPC_CHANNELS.knowledgeUpsertPerson:
      return wrap(() => requireRepo().upsertPerson(parsePersonInput(args[0])));
    case IPC_CHANNELS.knowledgeUpsertPlace:
      return wrap(() => requireRepo().upsertPlace(parsePlaceInput(args[0])));
    case IPC_CHANNELS.contextPreview:
      return wrap(() => requireRepo().previewContext(parseContextPreviewInput(args[0])));
    default: throw new Error("허용되지 않은 호출입니다.");
  }
}

async function wrap<T>(fn: () => T | Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    log.warn("browser bridge rejected", { code: errorCode(error) });
    return toResultError(error);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
  const requestOrigin = req.headers.origin;
  const host = req.headers.host;
  if (requestOrigin !== origin || (host !== `127.0.0.1:${BROWSER_BRIDGE_PORT}` && host !== `localhost:${BROWSER_BRIDGE_PORT}`)) {
    writeJson(res, 403, { error: "forbidden" }, origin);
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    });
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/api") {
    writeJson(res, 404, { error: "not_found" }, origin);
    return;
  }
  try {
    const body = await readBody(req) as { channel?: unknown; args?: unknown };
    if (typeof body.channel !== "string" || !ALLOWED_CHANNELS.has(body.channel as IpcChannel)) {
      throw new Error("허용되지 않은 호출입니다.");
    }
    const args = Array.isArray(body.args) ? body.args : [];
    writeJson(res, 200, { value: await dispatch(body.channel as IpcChannel, args) }, origin);
  } catch (error) {
    log.warn("browser bridge request failed", { code: errorCode(error) });
    writeJson(res, 400, { error: safeMessage(error) }, origin);
  }
}

export function startBrowserBridge(): void {
  if (server) return;
  const origin = rendererOrigin();
  if (!origin) return;
  const next = createServer((req, res) => void handle(req, res, origin));
  next.on("error", (error) => log.error("browser bridge failed", { code: errorCode(error) }));
  next.listen(BROWSER_BRIDGE_PORT, "127.0.0.1", () => {
    server = next;
    log.info("browser bridge ready", { port: BROWSER_BRIDGE_PORT });
  });
}

export function stopBrowserBridge(): void {
  const active = server;
  server = null;
  active?.close();
}
