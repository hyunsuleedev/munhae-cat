import { app, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IpcChannel, type IpcResult } from "../shared/munhae-api";
import { probeAgentsCached } from "./agents";
import { AppError, errorCode } from "./errors";
import { redact, log } from "./log";
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
  pickTextFile,
  openProjectInteractive,
  openProjectPathInOs,
  requireRepo,
  seedDemo,
  setAppConfig,
} from "./session";
import { getMainWindow } from "./window";

const ALLOWED_CHANNELS = new Set<string>(Object.values(IPC_CHANNELS));

function assertSender(event: IpcMainInvokeEvent): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    throw new AppError("invalid_sender", "허용되지 않은 호출입니다.");
  }
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  const redacted = redact(raw);
  return redacted.length > 400 ? `${redacted.slice(0, 400)}…` : redacted;
}

function toIpcError(error: unknown): IpcResult<never> {
  const code = errorCode(error);
  if (code === "internal") {
    log.error("ipc handler failed", { code, name: error instanceof Error ? error.name : "unknown" });
  } else {
    log.warn("ipc rejected", { code });
  }
  return { ok: false, error: { code, message: safeMessage(error) } };
}

function handleRaw(channel: IpcChannel, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`channel not allowed: ${channel}`);
  }
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
    return fn(event, ...args);
  });
}

function handleResult(channel: IpcChannel, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`channel not allowed: ${channel}`);
  }
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
    try {
      assertSender(event);
      return { ok: true, data: await fn(event, ...args) };
    } catch (error) {
      return toIpcError(error);
    }
  });
}

export function registerIpcHandlers(): void {
  handleRaw(IPC_CHANNELS.appGetVersion, () => app.getVersion());
  handleRaw(IPC_CHANNELS.appGetConfig, () => getAppConfig());
  handleRaw(IPC_CHANNELS.appSetConfig, (_event, patch) => setAppConfig(patch));
  handleRaw(IPC_CHANNELS.appProbeAgents, () => probeAgentsCached());
  handleRaw(IPC_CHANNELS.appQuit, () => {
    setImmediate(() => app.quit());
  });
  handleRaw(IPC_CHANNELS.appShowAbout, async () => {
    const options = {
      type: "info" as const,
      title: "Munhae Studio",
      message: `Munhae Studio ${app.getVersion()}`,
    };
    if (process.platform === "linux") {
      const win = getMainWindow();
      if (win) await dialog.showMessageBox(win, options);
      else await dialog.showMessageBox(options);
      return;
    }
    app.showAboutPanel();
  });
  handleRaw(IPC_CHANNELS.appOpenExternal, async (_event, url) => {
    if (typeof url !== "string") {
      throw new AppError("invalid_url", "https 주소만 열 수 있습니다.");
    }
    await openHttpsExternal(url);
  });
  handleRaw(IPC_CHANNELS.appOpenPath, async (_event, target) => {
    const path = parseOptionalPath(target);
    if (!path) {
      throw new AppError("invalid_path", "경로가 올바르지 않습니다.");
    }
    await openProjectPathInOs(path);
  });

  handleResult(IPC_CHANNELS.projectCreate, async (_event, input) => {
    return createProjectInteractive(parseCreateProjectInput(input));
  });
  handleResult(IPC_CHANNELS.projectOpen, async (_event, packagePath) => {
    return openProjectInteractive(parseOptionalPath(packagePath));
  });
  handleResult(IPC_CHANNELS.projectClose, () => {
    closeProject();
  });
  handleRaw(IPC_CHANNELS.projectGetCurrent, () => getCurrentSummary());
  handleRaw(IPC_CHANNELS.projectListRecent, () => listRecent());
  handleResult(IPC_CHANNELS.projectBackup, () => backupProject());
  handleResult(IPC_CHANNELS.projectCreateFromPaste, async (_event, input) => {
    return createFromPaste(parseCreateFromPasteInput(input));
  });
  handleResult(IPC_CHANNELS.projectSeedDemo, () => seedDemo());

  handleResult(IPC_CHANNELS.homeGet, () => getHome());
  handleResult(IPC_CHANNELS.documentCreate, (_event, input) => {
    return requireRepo().createDocument(parseCreateDocumentInput(input));
  });
  handleResult(IPC_CHANNELS.documentPickText, () => pickTextFile());

  handleResult(IPC_CHANNELS.editorGet, (_event, documentNodeId) => {
    return requireRepo().getEditor(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.editorSaveDraft, (_event, input) => {
    return requireRepo().saveTranslationDraft(parseSaveDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorConfirm, (_event, input) => {
    return requireRepo().confirmTranslation(parseConfirmInput(input));
  });
  handleResult(IPC_CHANNELS.editorRevise, (_event, documentNodeId, stage) => {
    return requireRepo().reviseTranslation(parseDocumentNodeId(documentNodeId), parseStage(stage));
  });
  handleResult(IPC_CHANNELS.editorMergeBlocks, (_event, input) => {
    return requireRepo().mergeBlocks(parseMergeBlocksInput(input));
  });
  handleResult(IPC_CHANNELS.editorSplitBlock, (_event, input) => {
    return requireRepo().splitBlock(parseSplitBlockInput(input));
  });

  handleResult(IPC_CHANNELS.knowledgeGet, () => requireRepo().getKnowledge());
  handleResult(IPC_CHANNELS.knowledgeUpsertGlossary, (_event, entry) => {
    return requireRepo().upsertGlossary(parseGlossaryInput(entry));
  });
  handleResult(IPC_CHANNELS.knowledgeUpsertPerson, (_event, person) => {
    return requireRepo().upsertPerson(parsePersonInput(person));
  });
  handleResult(IPC_CHANNELS.knowledgeUpsertPlace, (_event, place) => {
    return requireRepo().upsertPlace(parsePlaceInput(place));
  });

  handleResult(IPC_CHANNELS.contextPreview, (_event, input) => {
    return requireRepo().previewContext(parseContextPreviewInput(input));
  });
}
