import { onlineProjectAccount } from "../shared/online-projects";
import { translateUi } from "../shared/ui-translations";
import { createHash } from "node:crypto";
import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import type { ReviewExportInput, ReviewExportSaveResult, TranslationExportInput, TranslationExportSaveResult } from "../shared/munhae-api";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  app,
  dialog,
  shell,
  type BrowserWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from "electron";
import {
  createProject,
  openProject,
  seedDemoProject,
  type AppDb,
  type ProjectRepo,
} from "@munhae/db-sqlite";
import * as sqlite from "@munhae/db-sqlite";
import { readManifest, validateManifest } from "@munhae/project-format";
import {
  DEFAULT_APP_CONFIG,
  type AppConfig,
  type ConfirmedExportInput,
  type CreateDocumentInput,
  type CreateFromPasteInput,
  type CreateProjectInput,
  type HomeView,
  type ExportSaveResult,
  type ProjectSummary,
  type RecentProject,
} from "../shared/munhae-api";
import { getCachedAgentProbes } from "./agents";
import { loadAppConfig, mergeAppConfig, parseConfigPatch, saveAppConfig } from "./app-config";
import { AppError } from "./errors";
import { log } from "./log";
import { isInsidePackageRoot } from "./paths";
import { getMainWindow } from "./window";
import { extractMunhaePkg } from "./zip";
import { printHtmlToPdf } from "./print-pdf";
import { hasActiveAiRuns, cancelAllAiRuns } from "./ai-runs";
import { assertAuthenticatedUser, withAuthenticatedClient, subscribeAccountState, watchAuthenticatedProject } from "./auth";
import { OnlineProjectsService, onlineProjectId } from "./online-projects";
import { OnlineWorkspace } from "./online-workspace";
import { OnlinePostgresRemote } from "./online-postgres-remote";
import { emitProjectChange } from "./project-events";
import { OnlineWorkspaceRemote } from "./online-workspace-remote";
import type { OnlineWorkspaceStatus } from "../shared/online-projects";

type SessionState = {
  userDataDir: string;
  appDb: AppDb | null;
  config: AppConfig;
  current: ProjectRepo | null;
};

export type SessionTransitionPreflight = () => boolean | Promise<boolean>;
export type SyncSessionTransitionPreflight = () => boolean;

const state: SessionState = {
  userDataDir: "",
  appDb: null,
  config: DEFAULT_APP_CONFIG,
  current: null,
};
let onlineWorkspace: OnlineWorkspace | null = null;
let openingOnline = false;
let stopAccountWatch: (() => void) | null = null;
const onlineRemote = new OnlinePostgresRemote(withAuthenticatedClient);
const legacyOnlineRemote = new OnlineWorkspaceRemote(withAuthenticatedClient);
const onlineProjects = new OnlineProjectsService(withAuthenticatedClient);
type OnlineSaveReceipt = { value: unknown; editorDocumentId: string | null; generation: number; revision: number };
type OnlineSaveRetries = { receipts: Map<string, OnlineSaveReceipt>; flights: Map<string, Promise<unknown>> };
const onlineSaveRetries = new WeakMap<OnlineWorkspace, OnlineSaveRetries>();
const MAX_ONLINE_SAVE_RECEIPTS = 8;
const RETRYABLE_SAVE_CHANNELS = new Set<IpcChannel>([
  IPC_CHANNELS.documentCreate, IPC_CHANNELS.documentMove, IPC_CHANNELS.documentDelete, IPC_CHANNELS.documentUpdateMetadata,
  IPC_CHANNELS.editorSaveSourceDraft, IPC_CHANNELS.editorConfirmSource, IPC_CHANNELS.editorCreatePunctuationDraft,
  IPC_CHANNELS.editorSavePunctuationDraft, IPC_CHANNELS.editorConfirmPunctuation, IPC_CHANNELS.editorCreateTranslationDraft,
  IPC_CHANNELS.editorResetTranslationDraft, IPC_CHANNELS.editorSaveDraft, IPC_CHANNELS.editorConfirm, IPC_CHANNELS.editorRevise,
  IPC_CHANNELS.editorMergeBlocks, IPC_CHANNELS.editorSplitBlock, IPC_CHANNELS.editorSaveSentenceLink,
  IPC_CHANNELS.editorCreateReviewComment, IPC_CHANNELS.editorUpdateReviewComment, IPC_CHANNELS.editorArchiveReviewComment,
  IPC_CHANNELS.editorSaveReadingAnnotation, IPC_CHANNELS.editorArchiveReadingAnnotation, IPC_CHANNELS.editorAttachReference,
  IPC_CHANNELS.knowledgeSetMaterialPreference, IPC_CHANNELS.knowledgeReuseCommentAsMaterial,
  IPC_CHANNELS.knowledgeCreateContext, IPC_CHANNELS.knowledgeUpdateContext, IPC_CHANNELS.knowledgeSetContextEnabled,
  IPC_CHANNELS.knowledgeSetContextPriority, IPC_CHANNELS.knowledgeDeleteContext, IPC_CHANNELS.pluginsApply,
  IPC_CHANNELS.termsConfirm, IPC_CHANNELS.termsDismiss, IPC_CHANNELS.termsUpdate, IPC_CHANNELS.termsUpdateUse, IPC_CHANNELS.termsDelete, IPC_CHANNELS.termsDeleteProjectTerms,
  IPC_CHANNELS.termsStart, IPC_CHANNELS.termsCancel,
  IPC_CHANNELS.aiStartTranslation, IPC_CHANNELS.aiStartChat, IPC_CHANNELS.aiStartPunctuation, IPC_CHANNELS.aiApplyPunctuationSuggestion,
  IPC_CHANNELS.aiCancelRun, IPC_CHANNELS.researchStartMaterialRefinement, IPC_CHANNELS.researchCancelMaterialRefinement,
  IPC_CHANNELS.researchStartFootnoteAnalysis, IPC_CHANNELS.researchCancelFootnoteAnalysis,
  IPC_CHANNELS.researchStartReadingAnalysis, IPC_CHANNELS.researchCancelReadingAnalysis, IPC_CHANNELS.researchApplyReadingAnalysis,
]);

/** Hash only; neither document text nor auth inputs become durable retry keys/logs. */
export function onlineSaveRequestKey(channel: IpcChannel, args: readonly unknown[]): string | undefined {
  if (!RETRYABLE_SAVE_CHANNELS.has(channel)) return undefined;
  try {
    const canonical = JSON.stringify([channel, args], (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    return createHash("sha256").update(canonical).digest("hex");
  } catch { throw new AppError("invalid_input", "저장 요청 형식을 확인하세요."); }
}

function assertOnlineSaveWorkspace(workspace: OnlineWorkspace): void {
  assertAuthenticatedUser(onlineProjectAccount(workspace.project));
  if (onlineWorkspace !== workspace || state.current !== workspace.repo) {
    throw new AppError("project_transition", "프로젝트가 변경되어 이전 요청을 취소했습니다.");
  }
}

function receiptFor(workspace: OnlineWorkspace, value: unknown): OnlineSaveReceipt {
  const result = value as { project?: { projectId?: unknown }; document?: { id?: unknown }; source?: unknown } | null;
  const editorDocumentId = result?.project?.projectId === workspace.repo.projectId && result.source
    && typeof result.document?.id === "string" ? result.document.id : null;
  // EditorView can contain a whole book. Keep its identity and re-read current
  // versions after retry instead of retaining or returning an obsolete snapshot.
  return { value: editorDocumentId ? undefined : structuredClone(value), editorDocumentId,
    generation: workspace.changeGeneration, revision: workspace.status().revision };
}

function retryResult<T>(workspace: OnlineWorkspace, receipt: OnlineSaveReceipt): T {
  if (receipt.editorDocumentId) return workspace.repo.getEditor(receipt.editorDocumentId) as T;
  // A background sync of this receipt is safe. Additional local edits or later
  // remote commits make a cached non-editor row/result unsafe to reintroduce.
  if (workspace.changeGeneration !== receipt.generation || workspace.status().revision > receipt.revision + 1) {
    throw new AppError("online_save_result_changed", "앞선 변경은 보존되어 있지만 이후 내용이 바뀌었습니다. 작성 중인 내용을 보관하고 최신 상태를 다시 확인해 주세요.");
  }
  return structuredClone(receipt.value) as T;
}

function assertNoOnlineTransition(): void {
  if (openingOnline) throw new AppError("project_transition", "온라인 프로젝트를 여는 중입니다. 잠시 기다려 주세요.");
}

function toSummary(repo: ProjectRepo): ProjectSummary {
  if (onlineWorkspace?.repo === repo) return onlineWorkspace.summary;
  return {
    projectId: repo.projectId,
    title: repo.title,
    packagePath: repo.packagePath,
    storageMode: "local",
    openedAt: new Date().toISOString(),
  };
}

function parentWindow(): BrowserWindow | undefined {
  return getMainWindow() ?? undefined;
}

/** Agent 1 may export `openAppDb` (type OpenAppDb) or `openAppDatabase`. */
function openAppDatabase(userDataDir: string): AppDb {
  const exports = sqlite as unknown as Record<string, unknown>;
  const fn = exports.openAppDb ?? exports.openAppDatabase;
  if (typeof fn !== "function") {
    throw new AppError("internal", "앱 데이터베이스를 열 수 없습니다.");
  }
  return (fn as (dir: string) => AppDb)(userDataDir);
}

export function initSession(userDataDir: string): void {
  state.userDataDir = userDataDir;
  state.config = loadAppConfig(userDataDir);
  state.appDb = openAppDatabase(userDataDir);
  stopAccountWatch?.();
  stopAccountWatch = subscribeAccountState(account => {
    const workspace = onlineWorkspace;
    if (!workspace || (account.status === "signed_in" && account.user?.id === onlineProjectAccount(workspace.project))) return;
    // Hide the old account's working copy synchronously, including all existing project IPC reads.
    onlineSaveRetries.delete(workspace);
    onlineWorkspace = null;
    if (state.current === workspace.repo) state.current = null;
    try { if (workspace.project.role !== "viewer") workspace.markDirty(); }
    catch { log.warn("online recovery journal could not be updated"); }
    void cancelAllAiRuns().finally(() => workspace.close(true)).catch(() => undefined);
  });
  log.info("app session ready");
}

export function getAppConfig(): AppConfig {
  return state.config;
}

export function setAppConfig(patchUnknown: unknown): AppConfig {
  const patch = parseConfigPatch(patchUnknown);
  const next = mergeAppConfig(state.config, patch);
  if (next.translationLanguage !== state.config.translationLanguage && state.current && hasActiveAiRuns(state.current.projectId)) {
    throw new AppError("ai_run_active", "Wait for the active AI task to finish before changing the translation language.");
  }
  state.current?.setTranslationLanguage(next.translationLanguage);
  try { saveAppConfig(state.userDataDir, next); } catch (error) {
    state.current?.setTranslationLanguage(state.config.translationLanguage);
    throw error;
  }
  state.config = next;
  return state.config;
}

export function getCurrentSummary(): ProjectSummary | null {
  if (onlineWorkspace) {
    try { assertAuthenticatedUser(onlineProjectAccount(onlineWorkspace.project)); } catch { return null; }
  }
  return state.current ? toSummary(state.current) : null;
}

export function requireRepo(): ProjectRepo {
  if (!state.current) {
    throw new AppError("no_project", "열린 프로젝트가 없습니다.");
  }
  if (onlineWorkspace) assertAuthenticatedUser(onlineProjectAccount(onlineWorkspace.project));
  return state.current;
}

/** Native dialogs can stay open while another window changes account or project. */
function captureExportAccess(repo: ProjectRepo): () => void {
  const workspace = onlineWorkspace?.repo === repo ? onlineWorkspace : null;
  return () => {
    if (workspace) assertAuthenticatedUser(onlineProjectAccount(workspace.project));
    if (state.current !== repo || (workspace && onlineWorkspace !== workspace)) {
      throw new AppError("stale_request", "프로젝트가 변경되었습니다. 현재 프로젝트에서 다시 내보내 주세요.");
    }
  };
}

export function getOnlineWorkspaceStatus(): OnlineWorkspaceStatus | null {
  if (!onlineWorkspace) return null;
  try { return onlineWorkspace.status(); } catch { return null; }
}

export async function syncOnlineWorkspace(): Promise<OnlineWorkspaceStatus | null> {
  const workspace = onlineWorkspace;
  if (!workspace) return null;
  await workspace.flush();
  return workspace.status();
}

/** A successful online save reply means PostgreSQL accepted the mutation. Reads do not flush. */
export async function withOnlineProjectSave<T>(operation: () => T | Promise<T>, allowTransition = false, requestKey?: string): Promise<T> {
  const workspace = onlineWorkspace;
  if (workspace && requestKey && !allowTransition) {
    assertOnlineSaveWorkspace(workspace);
    let retries = onlineSaveRetries.get(workspace);
    if (!retries) { retries = { receipts: new Map(), flights: new Map() }; onlineSaveRetries.set(workspace, retries); }
    const existingFlight = retries.flights.get(requestKey);
    if (existingFlight) return existingFlight as Promise<T>;
    const receipt = retries.receipts.get(requestKey);
    if (!receipt && new Set([...retries.receipts.keys(), ...retries.flights.keys()]).size >= MAX_ONLINE_SAVE_RECEIPTS) {
      throw new AppError("online_save_retry_limit", "완료하지 못한 온라인 저장이 남아 있습니다. 앞선 저장을 다시 시도하거나 복구본을 보관한 뒤 계속하세요.");
    }
    const cache = retries;
    const flight = (async (): Promise<T> => {
      if (receipt) {
        await workspace.flush(); assertOnlineSaveWorkspace(workspace);
        const result = retryResult<T>(workspace, receipt);
        cache.receipts.delete(requestKey); return result;
      }
      const generation = workspace.changeGeneration;
      const value = await operation(); assertOnlineSaveWorkspace(workspace);
      if (workspace.changeGeneration !== generation) {
        cache.receipts.set(requestKey, receiptFor(workspace, value));
        await workspace.flush(); assertOnlineSaveWorkspace(workspace);
        cache.receipts.delete(requestKey);
      }
      return value;
    })();
    cache.flights.set(requestKey, flight);
    try { return await flight; }
    finally { cache.flights.delete(requestKey); }
  }
  const generation = workspace?.changeGeneration;
  const value = await operation();
  if (workspace && !allowTransition) {
    assertAuthenticatedUser(onlineProjectAccount(workspace.project));
    if (onlineWorkspace !== workspace) throw new AppError("project_transition", "프로젝트가 변경되어 이전 요청을 취소했습니다.");
  }
  if (workspace && onlineWorkspace === workspace && workspace.changeGeneration !== generation) {
    await workspace.flush();
    assertAuthenticatedUser(onlineProjectAccount(workspace.project));
    if (onlineWorkspace !== workspace) throw new AppError("project_transition", "프로젝트가 변경되어 이전 요청을 취소했습니다.");
  }
  return value;
}

/** The same hook is used after background AI completion and before leaving a workspace. */
export async function flushOnlineWorkspace(projectId?: string): Promise<void> {
  const workspace = onlineWorkspace;
  if (workspace && (!projectId || workspace.repo.projectId === projectId)) await workspace.flush();
}

export async function leaveOnlineWorkspace(keepUnsynced = false): Promise<void> {
  const workspace = onlineWorkspace;
  if (!workspace) return;
  if (hasActiveAiRuns(workspace.repo.projectId)) throw new AppError("ai_run_active", "AI 작업이 끝나거나 취소된 뒤 프로젝트를 바꿀 수 있습니다.");
  if (!keepUnsynced) await workspace.flush();
  if (onlineWorkspace !== workspace) throw new AppError("project_transition", "프로젝트가 변경되었습니다. 현재 상태를 확인해 주세요.");
  if (hasActiveAiRuns(workspace.repo.projectId)) throw new AppError("ai_run_active", "AI 작업이 진행 중입니다.");
  // Detach before awaiting release so no new operation can write into a closing workspace.
  if (state.current === workspace.repo) state.current = null;
  onlineSaveRetries.delete(workspace);
  onlineWorkspace = null;
  // The guarded flush above is complete. A second flush after detaching could
  // fail and leave an open working copy with no session through which to retry.
  await workspace.close(true);
}

export async function prepareOnlineAccountChange(): Promise<void> {
  if (!onlineWorkspace) return;
  assertNoOnlineTransition();
  await cancelAllAiRuns();
  await leaveOnlineWorkspace();
}

export async function openOnlineProject(input: unknown): Promise<ProjectSummary | null> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("invalid_input", "온라인 프로젝트를 선택하세요.");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "id" && key !== "discardLocal") || (value.discardLocal !== undefined && typeof value.discardLocal !== "boolean")) throw new AppError("invalid_input", "온라인 프로젝트 요청을 확인하세요.");
  const id = onlineProjectId(value.id);
  assertNoOnlineTransition();
  if (onlineWorkspace?.project.id === id && value.discardLocal !== true) {
    assertAuthenticatedUser(onlineProjectAccount(onlineWorkspace.project));
    return onlineWorkspace.summary;
  }
  if (hasActiveAiRuns()) throw new AppError("ai_run_active", "AI 작업이 끝나거나 취소된 뒤 프로젝트를 바꿀 수 있습니다.");
  openingOnline = true;
  let workspace: OnlineWorkspace | null = null;
  try {
    const project = await onlineProjects.get(id);
    if (onlineWorkspace) {
      // A deliberate server-version open keeps the pending local copy as a recovery package.
      await leaveOnlineWorkspace(value.discardLocal === true && onlineWorkspace.project.id === id);
    }
    workspace = await OnlineWorkspace.open(project, { remote: onlineRemote, legacy: legacyOnlineRemote, refreshProject: id => onlineProjects.get(id), watch: watchAuthenticatedProject, onChange: emitProjectChange,
      root: join(state.userDataDir, "online-projects"), assertUser: assertAuthenticatedUser }, value.discardLocal === true);
    assertAuthenticatedUser(project.accountId ?? project.ownerId);
    if (hasActiveAiRuns()) throw new AppError("ai_run_active", "AI 작업이 진행 중입니다.");
    const previous = state.current;
    if (project.role === "owner") workspace.repo.setTranslationLanguage(state.config.translationLanguage);
    await workspace.flush();
    state.current = workspace.repo;
    onlineWorkspace = workspace;
    previous?.close();
    return workspace.summary;
  } catch (error) {
    if (workspace && workspace !== onlineWorkspace) await workspace.close(true);
    throw error;
  } finally { openingOnline = false; }
}

export async function exportOnlineRecovery(input: unknown): Promise<string | null> {
  const id = onlineProjectId(input);
  // Recovery must remain available when the Data API or Storage is unreachable.
  const project = onlineWorkspace?.project.id === id ? onlineWorkspace.project : await withAuthenticatedClient(async (_client, ownerId) => {
    const path = join(OnlineWorkspace.directory(join(state.userDataDir, "online-projects"), ownerId, id), "workspace.munhae");
    if (!existsSync(path)) throw new AppError("not_found", "이 기기에 보관된 온라인 작업본이 없습니다.");
    return { id, ownerId, accountId: ownerId, title: readManifest(path).title };
  });
  const directory = OnlineWorkspace.directory(join(state.userDataDir, "online-projects"), project.accountId ?? project.ownerId, project.id);
  const packagePath = join(directory, "workspace.munhae");
  if (!existsSync(packagePath)) throw new AppError("not_found", "이 기기에 보관된 온라인 작업본이 없습니다.");
  const result = await saveDialog({ title: "온라인 작업 복구본 내보내기",
    defaultPath: join(app.getPath("documents"), backupFileName(`${project.title}-복구본`)),
    filters: [{ name: "Munhae backup", extensions: ["munhaepkg"] }] });
  if (result.canceled || !result.filePath) return null;
  assertAuthenticatedUser(project.accountId ?? project.ownerId);
  const repo = onlineWorkspace?.project.id === project.id ? onlineWorkspace.repo : openProject(packagePath, { onlineCache: true });
  const destination = result.filePath.endsWith(".munhaepkg") ? result.filePath : `${result.filePath}.munhaepkg`;
  try { repo.backupTo(destination); } finally { if (repo !== onlineWorkspace?.repo) repo.close(); }
  return destination;
}

export function getRuntimeSessionRef(input: {
  providerKind: "codex" | "claude" | "antigravity";
  projectId: string;
  threadId: string;
}): string | null {
  return state.appDb?.getRuntimeSessionRef(input) ?? null;
}

export function setRuntimeSessionRef(
  input: { providerKind: "codex" | "claude" | "antigravity"; projectId: string; threadId: string },
  providerSessionRef: string,
): void {
  if (!state.appDb) throw new AppError("app_db_unavailable", "앱 runtime session 저장소를 사용할 수 없습니다.");
  state.appDb.setRuntimeSessionRef(input, providerSessionRef);
}

export function clearRuntimeSession(input: {
  providerKind: "codex" | "claude" | "antigravity";
  projectId: string;
  threadId: string;
}): void {
  state.appDb?.clearRuntimeSession(input);
}

export function listRecent(): RecentProject[] {
  const rows: RecentProject[] = state.appDb?.listRecent() ?? [];
  return rows.map((row) => {
    const missing = !existsSync(row.packagePath);
    if (missing) {
      try {
        state.appDb?.markMissing(row.packagePath);
      } catch {
        // keep listing even if mark fails
      }
    }
    return { ...row, missing };
  });
}

function adoptRepo(repo: ProjectRepo, summary?: ProjectSummary): ProjectSummary {
  const prev = state.current;
  if (prev && prev !== repo && hasActiveAiRuns(prev.projectId)) {
    repo.close();
    throw new AppError("ai_run_active", "AI 번역이 끝나거나 취소된 뒤 프로젝트를 바꿀 수 있습니다.");
  }
  repo.setTranslationLanguage(state.config.translationLanguage);
  state.current = repo;
  if (prev && prev !== repo) {
    try {
      prev.close();
    } catch (error) {
      log.warn("close previous project failed", { projectId: prev.projectId });
      void error;
    }
  }
  const resolved = summary ?? toSummary(repo);
  try {
    state.appDb?.upsertRecent({
      projectId: resolved.projectId,
      displayName: resolved.title,
      packagePath: resolved.packagePath,
    });
  } catch (error) {
    log.warn("upsert recent failed", { projectId: resolved.projectId });
    void error;
  }
  log.info("project opened", { projectId: resolved.projectId });
  return resolved;
}

async function openDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const localize = (value: string | undefined) => value === undefined ? undefined : translateUi(value, state.config.language);
  options = { ...options, title: localize(options.title), message: localize(options.message), buttonLabel: localize(options.buttonLabel),
    filters: options.filters?.map(filter => ({ ...filter, name: localize(filter.name)! })) };

  const win = parentWindow();
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

async function saveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const localize = (value: string | undefined) => value === undefined ? undefined : translateUi(value, state.config.language);
  options = { ...options, title: localize(options.title), message: localize(options.message), buttonLabel: localize(options.buttonLabel),
    filters: options.filters?.map(filter => ({ ...filter, name: localize(filter.name)! })) };

  const win = parentWindow();
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options);
}

async function chooseDirectory(title: string): Promise<string | null> {
  const result = await openDialog({
    title,
    buttonLabel: "선택",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

async function chooseProjectPath(): Promise<string | null> {
  const result = await openDialog({
    title: "문해 프로젝트 열기",
    message: ".munhae 폴더 또는 .munhaepkg 백업을 선택하세요.",
    buttonLabel: "열기",
    // macOS selects .munhae packages as files; ordinary folders remain navigable.
    // Requires Electron's package-filter fix (electron/electron#49444).
    properties: process.platform === "darwin" ? ["openFile"] : ["openFile", "openDirectory"],
    filters: [{ name: "문해 프로젝트 및 백업", extensions: ["munhae", "munhaepkg"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

function assertExistingDir(dir: string): string {
  const resolved = resolve(dir);
  if (resolved.includes("\0")) {
    throw new AppError("invalid_path", "경로가 올바르지 않습니다.");
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new AppError("invalid_path", "폴더를 찾을 수 없습니다.");
  }
  return resolved;
}

async function materializePackage(rawPath: string): Promise<string> {
  const resolved = resolve(rawPath);
  if (!existsSync(resolved)) {
    try {
      state.appDb?.markMissing(resolved);
    } catch {
      // ignore
    }
    throw new AppError("not_found", "프로젝트 경로를 찾을 수 없습니다.");
  }
  const st = statSync(resolved);
  if (st.isFile() && resolved.toLowerCase().endsWith(".munhaepkg")) {
    const extracted = await extractMunhaePkg(resolved);
    assertManifest(extracted);
    return extracted;
  }
  if (st.isDirectory()) {
    assertManifest(resolved);
    return resolved;
  }
  throw new AppError("invalid_package", "문해 프로젝트 폴더가 아닙니다.");
}

function assertManifest(packagePath: string): void {
  const manifest = readManifest(packagePath);
  validateManifest(manifest);
}

export function openProjectFromPath(rawPath: string): Promise<ProjectSummary>;
export function openProjectFromPath(
  rawPath: string,
  beforeAdopt: SessionTransitionPreflight,
): Promise<ProjectSummary | null>;
export async function openProjectFromPath(
  rawPath: string,
  beforeAdopt?: SessionTransitionPreflight,
): Promise<ProjectSummary | null> {
  assertNoOnlineTransition();
  // Internal account caches must only be opened through authenticated online session handling.
  if (isInsidePackageRoot(join(state.userDataDir, "online-projects"), resolve(rawPath))) throw new AppError("invalid_path", "온라인 프로젝트는 온라인 목록에서 열어 주세요.");
  if (state.current && resolve(state.current.packagePath) === resolve(rawPath)) {
    return toSummary(state.current);
  }
  if (state.current && hasActiveAiRuns(state.current.projectId)) {
    throw new AppError("ai_run_active", "AI 번역이 끝나거나 취소된 뒤 프로젝트를 바꿀 수 있습니다.");
  }
  const packagePath = await materializePackage(rawPath);
  if (state.current && resolve(state.current.packagePath) === resolve(packagePath)) {
    return toSummary(state.current);
  }
  const repo = openProject(packagePath);
  let adopted = false;
  try {
    if (beforeAdopt && !(await beforeAdopt())) return null;
    await leaveOnlineWorkspace();
    adopted = true;
    return adoptRepo(repo);
  } finally {
    if (!adopted) repo.close();
  }
}

export async function openProjectInteractive(
  packagePath?: string,
  beforeAdopt?: SessionTransitionPreflight,
): Promise<ProjectSummary | null> {
  const chosen = packagePath ?? (await chooseProjectPath());
  if (!chosen) return null;
  return beforeAdopt
    ? openProjectFromPath(chosen, beforeAdopt)
    : openProjectFromPath(chosen);
}

export function createProjectInteractive(input: CreateProjectInput): Promise<ProjectSummary>;
export function createProjectInteractive(
  input: CreateProjectInput,
  beforeAdopt: SessionTransitionPreflight,
): Promise<ProjectSummary | null>;
export async function createProjectInteractive(
  input: CreateProjectInput,
  beforeAdopt?: SessionTransitionPreflight,
): Promise<ProjectSummary | null> {
  assertNoOnlineTransition();
  const parentDir = input.parentDir
    ? assertExistingDir(input.parentDir)
    : await chooseDirectory("새 프로젝트를 만들 폴더");
  if (!parentDir) {
    throw new AppError("cancelled", "폴더 선택이 취소되었습니다.");
  }
  if (beforeAdopt && !(await beforeAdopt())) return null;
  await leaveOnlineWorkspace();
  const created = createProject({ title: input.title, parentDir });
  return adoptRepo(created.handle, created.summary);
}

export async function createFromPaste(input: CreateFromPasteInput): Promise<ProjectSummary> {
  const summary = await createProjectInteractive({
    title: input.title,
    parentDir: input.parentDir,
  });
  const repo = requireRepo();
  const root = repo.getHome().documents.find((document) => document.isMaster);
  const docInput: CreateDocumentInput = {
    title: input.title,
    parentId: root?.id ?? null,
    nodeRole: "source_unit",
    originKind: "paste",
    sourceText: input.sourceText,
  };
  repo.createDocument(docInput);
  return summary;
}

function demoParentDir(): string {
  const documents = join(app.getPath("documents"), "문해");
  try {
    mkdirSync(documents, { recursive: true });
    return documents;
  } catch {
    const fallback = join(state.userDataDir, "demo");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function seedDemo(): ProjectSummary;
export function seedDemo(beforeAdopt: SyncSessionTransitionPreflight): ProjectSummary | null;
export function seedDemo(beforeAdopt?: SyncSessionTransitionPreflight): ProjectSummary | null {
  assertNoOnlineTransition();
  if (onlineWorkspace) throw new AppError("online_workspace_pending", "온라인 프로젝트를 닫은 뒤 데모를 여세요.");
  if (beforeAdopt && !beforeAdopt()) return null;
  const repo = seedDemoProject(demoParentDir());
  return adoptRepo(repo);
}

export function closeProject(
  force = false,
  beforeClose?: SyncSessionTransitionPreflight,
): void {
  if (!force) {
    assertNoOnlineTransition();
    if (onlineWorkspace) throw new AppError("online_workspace_pending", "온라인 프로젝트 저장을 마친 뒤 닫아 주세요.");
  }
  const current = state.current;
  if (!current) return;
  if (!force && hasActiveAiRuns(current.projectId)) {
    throw new AppError("ai_run_active", "AI 번역이 끝나거나 취소된 뒤 프로젝트를 닫을 수 있습니다.");
  }
  if (!force && beforeClose && !beforeClose()) return;
  state.current = null;
  try {
    current.close();
  } catch (error) {
    log.warn("project close failed", { projectId: current.projectId });
    void error;
  }
  log.info("project closed", { projectId: current.projectId });
}

function backupFileName(title: string, date = new Date()): string {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "munhae";
  return `${safe}-${day}.munhaepkg`;
}

export async function backupProject(): Promise<string | null> {
  const repo = requireRepo();
  const assertExportAccess = captureExportAccess(repo);
  const parent = onlineWorkspace ? app.getPath("documents") : dirname(repo.packagePath);
  const defaultPath = join(parent, backupFileName(repo.title));
  const result = await saveDialog({
    title: "프로젝트 백업",
    defaultPath,
    filters: [{ name: "Munhae backup", extensions: ["munhaepkg"] }],
  });
  if (result.canceled || !result.filePath) return null;
  assertExportAccess();
  const dest = result.filePath.toLowerCase().endsWith(".munhaepkg")
    ? result.filePath
    : `${result.filePath}.munhaepkg`;
  repo.backupTo(dest);
  log.info("project backup", { projectId: repo.projectId });
  return dest;
}

export async function exportConfirmedTranslations(
  input: ConfirmedExportInput,
): Promise<ExportSaveResult | null> {
  const repo = requireRepo();
  const assertExportAccess = captureExportAccess(repo);
  const payload = repo.createConfirmedExport(input);
  const labels = {
    markdown: "Markdown",
    json: "JSON",
    csv: "CSV",
  } as const;
  const result = await saveDialog({
    title: `확정 번역 ${labels[payload.format]} 내보내기`,
    defaultPath: join(onlineWorkspace ? app.getPath("documents") : dirname(repo.packagePath), `${payload.suggestedBaseName}.${payload.extension}`),
    filters: [{ name: labels[payload.format], extensions: [payload.extension] }],
  });
  if (result.canceled || !result.filePath) return null;
  assertExportAccess();
  const suffix = `.${payload.extension}`;
  const filePath = result.filePath.toLocaleLowerCase().endsWith(suffix)
    ? result.filePath
    : `${result.filePath}${suffix}`;
  writeFileSync(filePath, payload.content, { encoding: "utf8" });
  log.info("confirmed translations exported", {
    projectId: repo.projectId,
    format: payload.format,
    count: payload.confirmedTranslationCount,
  });
  return {
    filePath,
    format: payload.format,
    confirmedTranslationCount: payload.confirmedTranslationCount,
    manifestHash: payload.manifestHash,
  };
}

export async function pickTextFile(): Promise<string | null> {
  const result = await openDialog({
    title: "원문 텍스트 가져오기",
    buttonLabel: "가져오기",
    properties: ["openFile"],
    filters: [
      { name: "Text", extensions: ["txt", "md", "text"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  const st = statSync(path);
  if (st.size > 20_000_000) {
    throw new AppError("too_large", "파일이 20MB를 넘습니다.");
  }
  return readFileSync(path, "utf8");
}

export function pluginLibraryDir(): string {
  return join(state.userDataDir, "plugins");
}

/** A plugin is a SKILL.md file, or a folder that contains one. */
export async function pickSkillFile(): Promise<string | null> {
  const result = await openDialog({
    title: "플러그인 가져오기",
    message: "SKILL.md 파일이나 SKILL.md가 들어 있는 폴더를 선택하세요.",
    buttonLabel: "가져오기",
    properties: process.platform === "darwin" ? ["openFile", "openDirectory"] : ["openFile"],
    filters: [{ name: "SKILL.md", extensions: ["md"] }],
  });
  const picked = result.filePaths[0];
  if (result.canceled || !picked) return null;
  const path = statSync(picked).isDirectory() ? join(picked, "SKILL.md") : picked;
  if (!existsSync(path)) throw new AppError("not_found", "선택한 폴더에 SKILL.md가 없습니다.");
  if (statSync(path).size > 1_000_000) throw new AppError("too_large", "SKILL.md가 1MB를 넘습니다.");
  return readFileSync(path, "utf8");
}

export async function getHome(): Promise<HomeView> {
  // The repository counts source-bearing work units; structure-only nodes remain navigation.
  const view = requireRepo().getHome();
  view.agents = getCachedAgentProbes();
  return view;
}

export function assertInsideCurrentProject(target: string): string {
  const repo = requireRepo();
  const resolved = resolve(target);
  if (!isInsidePackageRoot(repo.packagePath, resolved)) {
    throw new AppError("invalid_path", "프로젝트 폴더 밖의 경로는 열 수 없습니다.");
  }
  return resolved;
}

export async function openProjectPathInOs(target: string): Promise<void> {
  const resolved = assertInsideCurrentProject(target);
  const err = await shell.openPath(resolved);
  if (err) {
    throw new AppError("open_path_failed", "경로를 열 수 없습니다.");
  }
}

export function shutdownSession(): void {
  stopAccountWatch?.();
  stopAccountWatch = null;
  closeProject(true);
  if (state.appDb) {
    try {
      state.appDb.close();
    } catch (error) {
      log.warn("app db close failed");
      void error;
    }
    state.appDb = null;
  }
}

export function projectPathFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (!arg || arg.startsWith("-")) continue;
    if (arg === process.execPath) continue;
    if (/\.(mjs|cjs|js)$/i.test(arg) && !/\.munhae/i.test(arg)) continue;
    const lower = arg.toLowerCase();
    if (lower.endsWith(".munhae") || lower.endsWith(".munhaepkg")) return arg;
  }
  return null;
}

export async function exportReviewTranslations(input: ReviewExportInput): Promise<ReviewExportSaveResult | null> {
  const repo = requireRepo();
  const assertExportAccess = captureExportAccess(repo);
  const payload = repo.createReviewExport(input);
  const result = await saveDialog({ title: "번역 검토본 내보내기", defaultPath: join(onlineWorkspace ? app.getPath("documents") : dirname(repo.packagePath), `${payload.suggestedBaseName}.${payload.extension}`), filters: [{ name: payload.format === "html" ? "인쇄용 HTML" : "Markdown", extensions: [payload.extension] }] });
  if (result.canceled || !result.filePath) return null;
  assertExportAccess();
  const suffix = `.${payload.extension}`;
  const filePath = result.filePath.toLowerCase().endsWith(suffix) ? result.filePath : `${result.filePath}${suffix}`;
  writeFileSync(filePath, payload.content, { encoding: "utf8" });
  return { filePath, format: payload.format, documentCount: payload.documentCount };
}

const TRANSLATION_EXPORT_FILTERS = { docx: "Word 문서", pdf: "PDF", txt: "텍스트", markdown: "Markdown" } as const;

export async function exportTranslationDocument(input: TranslationExportInput): Promise<TranslationExportSaveResult | null> {
  const repo = requireRepo();
  const assertExportAccess = captureExportAccess(repo);
  const payload = repo.createTranslationExport(input);
  const result = await saveDialog({ title: "번역본 내보내기", defaultPath: join(onlineWorkspace ? app.getPath("documents") : dirname(repo.packagePath), `${payload.suggestedBaseName}.${payload.extension}`), filters: [{ name: TRANSLATION_EXPORT_FILTERS[payload.format], extensions: [payload.extension] }] });
  if (result.canceled || !result.filePath) return null;
  assertExportAccess();
  const suffix = `.${payload.extension}`;
  const filePath = result.filePath.toLowerCase().endsWith(suffix) ? result.filePath : `${result.filePath}${suffix}`;
  // The PDF is printed only after a location is chosen, so cancelling costs nothing.
  const content = payload.format === "docx" ? payload.bytes : payload.format === "pdf" ? await printHtmlToPdf(payload.printHtml) : payload.text;
  writeFileSync(filePath, content);
  log.info("translation exported", { projectId: repo.projectId, format: payload.format, count: payload.documentCount });
  return { filePath, format: payload.format, documentCount: payload.documentCount };
}
