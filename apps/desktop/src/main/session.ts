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
import { hasActiveAiRuns } from "./ai-runs";

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

function toSummary(repo: ProjectRepo): ProjectSummary {
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
  log.info("app session ready");
}

export function getAppConfig(): AppConfig {
  return state.config;
}

export function setAppConfig(patchUnknown: unknown): AppConfig {
  const patch = parseConfigPatch(patchUnknown);
  state.config = mergeAppConfig(state.config, patch);
  saveAppConfig(state.userDataDir, state.config);
  return state.config;
}

export function getCurrentSummary(): ProjectSummary | null {
  return state.current ? toSummary(state.current) : null;
}

export function requireRepo(): ProjectRepo {
  if (!state.current) {
    throw new AppError("no_project", "열린 프로젝트가 없습니다.");
  }
  return state.current;
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
  const win = parentWindow();
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

async function saveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue> {
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
    properties: ["openFile", "openDirectory", "createDirectory"],
    filters: [
      { name: "Munhae", extensions: ["munhae", "munhaepkg"] },
      { name: "All Files", extensions: ["*"] },
    ],
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
  const parentDir = input.parentDir
    ? assertExistingDir(input.parentDir)
    : await chooseDirectory("새 프로젝트를 만들 폴더");
  if (!parentDir) {
    throw new AppError("cancelled", "폴더 선택이 취소되었습니다.");
  }
  if (beforeAdopt && !(await beforeAdopt())) return null;
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
  if (beforeAdopt && !beforeAdopt()) return null;
  const repo = seedDemoProject(demoParentDir());
  return adoptRepo(repo);
}

export function closeProject(
  force = false,
  beforeClose?: SyncSessionTransitionPreflight,
): void {
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
  const parent = dirname(repo.packagePath);
  const defaultPath = join(parent, backupFileName(repo.title));
  const result = await saveDialog({
    title: "프로젝트 백업",
    defaultPath,
    filters: [{ name: "Munhae backup", extensions: ["munhaepkg"] }],
  });
  if (result.canceled || !result.filePath) return null;
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
  const payload = repo.createConfirmedExport(input);
  const labels = {
    markdown: "Markdown",
    json: "JSON",
    csv: "CSV",
  } as const;
  const result = await saveDialog({
    title: `확정 번역 ${labels[payload.format]} 내보내기`,
    defaultPath: join(dirname(repo.packagePath), `${payload.suggestedBaseName}.${payload.extension}`),
    filters: [{ name: labels[payload.format], extensions: [payload.extension] }],
  });
  if (result.canceled || !result.filePath) return null;
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
