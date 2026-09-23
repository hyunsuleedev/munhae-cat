import { onlineProjectAccount } from "../shared/online-projects";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, fsyncSync, openSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProject, openProject, openOnlineCache, diffOnlineRows, applyOnlineRowChanges, isOnlineAssetPath,
  type ProjectRepo, type OnlineTableData, type OnlineRowChange } from "@munhae/db-sqlite";
import type { OnlineProject, OnlineWorkspaceStatus, ProjectChangeEvent } from "../shared/online-projects";
import type { ProjectSummary } from "../shared/munhae-api";
import { AppError } from "./errors";
import { extractZip } from "./zip";
import { assetHash, emptyOnlineRows, type OnlinePostgresRemote, type OnlineDataHead } from "./online-postgres-remote";
import type { OnlineWorkspaceRemote } from "./online-workspace-remote";

type PendingCommit = { mutationId: string; revision: number; generation: number; changes: OnlineRowChange[] };
type Journal = { version: 2; ownerId: string; projectId: string; localProjectId: string; revision: number;
  generation: number; dirty: boolean; base: OnlineTableData; pending: PendingCommit | null };
type Dependencies = { remote: OnlinePostgresRemote; legacy?: OnlineWorkspaceRemote; root: string;
  assertUser(userId: string): void; onLostAccess?(): void; onChange?(event: ProjectChangeEvent): void;
  refreshProject?(projectId: string): Promise<OnlineProject>;
  watch?(projectId: string, notice: (revision: number | null) => void, connected: (state: boolean) => void): Promise<() => void> };
const message = (error: unknown) => error instanceof Error ? error.message : "온라인 저장에 실패했습니다. 다시 시도하세요.";
const conflict = (): never => { throw new AppError("online_workspace_conflict", "다른 기기에서 먼저 저장했습니다. 이 기기의 복구본을 내보내거나 서버 버전으로 열어 주세요."); };
function save(directory: string, journal: Journal): void {
  const path = join(directory, "journal.json"), temporary = path + ".tmp";
  const fd = openSync(temporary, "w", 0o600);
  try { writeFileSync(fd, JSON.stringify(journal) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}
async function uploadAssets(deps: Dependencies, project: OnlineProject, packagePath: string, tables: OnlineTableData): Promise<void> {
  const uploaded = new Set<string>();
  for (const row of tables.src_asset_locations ?? []) {
    if (!isOnlineAssetPath(row.relative_path)) throw new AppError("invalid_input", "첨부 경로를 확인하세요.");
    const asset = tables.src_assets?.find(asset => asset.id === row.asset_id);
    if (!asset || typeof asset.sha256 !== "string") throw new AppError("online_workspace_integrity", "첨부 파일 정보가 없습니다.");
    if (uploaded.has(asset.sha256)) continue;
    const bytes = readFileSync(join(packagePath, row.relative_path));
    if (assetHash(bytes) !== asset.sha256 || bytes.length !== asset.byte_size) throw new AppError("online_workspace_integrity", "첨부 파일이 변경되었거나 손상되었습니다.");
    await deps.remote.uploadAsset(project.id, bytes, project.ownerId); deps.assertUser(onlineProjectAccount(project)); uploaded.add(asset.sha256);
  }
}
async function downloadAssets(deps: Dependencies, project: OnlineProject, packagePath: string, tables: OnlineTableData): Promise<void> {
  for (const row of tables.src_asset_locations ?? []) {
    if (!isOnlineAssetPath(row.relative_path)) throw new AppError("invalid_input", "첨부 경로를 확인하세요.");
    const asset = tables.src_assets?.find(asset => asset.id === row.asset_id);
    if (!asset || typeof asset.sha256 !== "string") throw new AppError("online_workspace_integrity", "첨부 파일 정보가 없습니다.");
    const path = join(packagePath, row.relative_path);
    if (existsSync(path) && assetHash(readFileSync(path)) === asset.sha256) continue;
    const bytes = await deps.remote.downloadAsset(project.id, asset.sha256, project.ownerId); deps.assertUser(onlineProjectAccount(project));
    if (bytes.length !== asset.byte_size) throw new AppError("online_workspace_integrity", "첨부 파일 크기가 일치하지 않습니다.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path + ".download", bytes, { mode: 0o600 }); renameSync(path + ".download", path);
  }
}

/** PostgreSQL is authoritative. SQLite is a disposable local execution/editor cache.
 * Local intent and exact mutation UUID survive response loss. No cloud SQLite files or writer leases. */
export class OnlineWorkspace {
  readonly sessionId = randomUUID();
  readonly packagePath: string;
  readonly summary: ProjectSummary;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private stopWatch: (() => void) | null = null;
  private serial: Promise<void> = Promise.resolve();
  private closed = false;
  private phase: OnlineWorkspaceStatus["state"] = "synced";
  private failure: string | null = null;
  private connected = false;
  private updatedAt: string;
  private constructor(readonly project: OnlineProject, readonly repo: ProjectRepo, private deps: Dependencies,
    readonly directory: string, private journal: Journal, head: OnlineDataHead) {
    this.packagePath = repo.packagePath; this.updatedAt = head.updatedAt;
    this.summary = { projectId: repo.projectId, title: project.title, openedAt: repo.openedAt, storageMode: "online",
      onlineProjectId: project.id, accountId: onlineProjectAccount(project), packagePath: `online://${onlineProjectAccount(project)}/${project.id}` };
    repo.configureWorkspace({ summary: this.summary, beforeOperation: (method, mutating) => this.assertOperation(method, mutating), onChange: () => this.markDirty() });
  }
  static directory(root: string, ownerId: string, projectId: string): string {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(ownerId) || !uuid.test(projectId)) throw new AppError("invalid_input", "온라인 프로젝트 식별자가 올바르지 않습니다.");
    return join(root, ownerId, projectId);
  }
  static async open(project: OnlineProject, deps: Dependencies, discardLocal = false): Promise<OnlineWorkspace> {
    deps.assertUser(onlineProjectAccount(project));
    const directory = this.directory(deps.root, onlineProjectAccount(project), project.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const packagePath = join(directory, "workspace.munhae"), journalPath = join(directory, "journal.json");
    let stored: any = null;
    if (existsSync(journalPath)) {
      try { stored = JSON.parse(readFileSync(journalPath, "utf8"));
        if (![1, 2].includes(stored.version) || stored.ownerId !== onlineProjectAccount(project) || stored.projectId !== project.id
          || !Number.isSafeInteger(stored.revision) || stored.revision < 0 || !Number.isSafeInteger(stored.generation)
          || typeof stored.dirty !== "boolean") throw new Error("journal");
        if (stored.version === 2) diffOnlineRows(emptyOnlineRows(), stored.base);
      } catch { throw new AppError("online_workspace_recovery", "온라인 작업본의 복구 정보를 확인할 수 없습니다. 복구본을 내보내 주세요."); }
    }
    if (project.role === "viewer" && (stored?.dirty || stored?.pending) && !discardLocal) throw new AppError("online_workspace_readonly", "열람 권한으로 변경되었습니다. 이전 작업의 복구본을 내보낸 뒤 서버 버전으로 열어 주세요.");
    const initializing = join(directory, "initial-commit.json");
    if (existsSync(initializing) && !discardLocal) {
      const initial = JSON.parse(readFileSync(initializing, "utf8"));
      if (initial.projectId !== project.id || initial.ownerId !== onlineProjectAccount(project)) throw new AppError("online_workspace_integrity", "초기 저장 복구 정보가 일치하지 않습니다.");
      try {
        await deps.remote.commit(project.id, 0, initial.mutationId, initial.changes, initial.legacy);
        deps.assertUser(onlineProjectAccount(project));
        // No editor was exposed before this initialization completed.
        stored = null;
      } catch (error) {
        if ((error as { code?: string }).code !== "online_workspace_lease_lost") throw error;
        // The old lease can expire before a rejected initial commit. Keep the
        // original cache and reacquire against the current legacy revision below.
        rmSync(initializing, { force: true });
      }
    }
    // Retry the exact frozen mutation before interpreting a newer server revision as a conflict.
    if (stored?.version === 2 && stored.pending && !discardLocal) {
      const pending = stored.pending as PendingCommit;
      const next = applyOnlineRowChanges(stored.base, pending.changes);
      await uploadAssets(deps, project, packagePath, { ...next, src_asset_locations: pending.changes
        .filter(change => change.table === "src_asset_locations" && change.after).map(change => change.after!) });
      const accepted = await deps.remote.commit(project.id, pending.revision, pending.mutationId, pending.changes);
      deps.assertUser(onlineProjectAccount(project));
      stored.base = next; stored.revision = accepted.revision;
      stored.dirty = stored.generation !== pending.generation; stored.pending = null; save(directory, stored);
    }
    let head = await deps.remote.get(project.id); deps.assertUser(onlineProjectAccount(project));
    if (head.revision === 0) {
      if (project.role !== "owner") throw new AppError("online_workspace_readonly", "소유자가 프로젝트를 먼저 열어야 합니다.");
      head = await this.initialize(project, deps, directory, stored, discardLocal);
      // Legacy cache has just been committed as normalized PostgreSQL rows.
      stored = null;
    }
    if (!head.dataProjectId) throw new AppError("online_workspace_integrity", "온라인 프로젝트 데이터가 없습니다.");
    if (stored?.dirty && !discardLocal && (stored.version !== 2 || stored.revision !== head.revision)) conflict();
    let repo: ProjectRepo | null = null, workspace: OnlineWorkspace | null = null;
    try {
      const keep = stored?.version === 2 && !discardLocal && stored.revision === head.revision && existsSync(packagePath);
      if (keep) repo = openProject(packagePath, { onlineCache: true });
      else {
        const staging = join(directory, `prepare-${randomUUID()}`); mkdirSync(staging, { mode: 0o700 });
        try {
          const cache = openOnlineCache({ parentDir: staging, title: project.title, projectId: head.dataProjectId, tables: head.tables });
          const incoming = cache.packagePath; cache.close();
          await downloadAssets(deps, project, incoming, head.tables); deps.assertUser(onlineProjectAccount(project));
          if (existsSync(packagePath)) renameSync(packagePath, join(directory, `recovery-${Date.now()}.munhae`));
          renameSync(incoming, packagePath);
        } finally { rmSync(staging, { recursive: true, force: true }); }
        repo = openProject(packagePath, { onlineCache: true });
      }
      if (repo.projectId !== head.dataProjectId) throw new AppError("online_workspace_integrity", "온라인 캐시의 프로젝트가 일치하지 않습니다.");
      const journal: Journal = keep ? stored : { version: 2, ownerId: onlineProjectAccount(project), projectId: project.id,
        localProjectId: head.dataProjectId, revision: head.revision, generation: 0, dirty: false, pending: null, base: head.tables };
      save(directory, journal);
      rmSync(initializing, { force: true });
      workspace = new OnlineWorkspace(project, repo, deps, directory, journal, head);
      await workspace.flush();
      if (deps.watch) workspace.stopWatch = await deps.watch(project.id,
        revision => { if (revision === null || revision > workspace!.journal.revision) void workspace!.pull(revision === null ? "resync" : "commit").catch(() => undefined); },
        connected => { workspace!.connected = connected; });
      // Subscribe before final read; the acknowledgement callback catches subsequent reconnects too.
      await workspace.pull("resync");
      workspace.heartbeat = setInterval(() => { void workspace!.pull("resync").catch(() => undefined); }, 30000);
      workspace.heartbeat.unref(); return workspace;
    } catch (error) { if (workspace) await workspace.close(true); else repo?.close(); throw error; }
  }
  private static async initialize(project: OnlineProject, deps: Dependencies, directory: string, stored: any, discard: boolean): Promise<OnlineDataHead> {
    const staging = join(directory, `initialize-${randomUUID()}`); mkdirSync(staging, { mode: 0o700 });
    let repo: ProjectRepo | null = null;
    let release: (() => Promise<void>) | null = null;
    let legacyCommit: { leaseId: string; fence: number } | undefined;
    try {
      const legacy = await deps.legacy?.get(project.id);
      deps.assertUser(onlineProjectAccount(project));
      if (legacy?.objectPath && deps.legacy) {
        const leaseId = stored?.version === 1 ? stored.leaseId : randomUUID();
        const locked = await deps.legacy.acquire(project.id, leaseId);
        release = () => deps.legacy!.release(project.id, leaseId, locked.fence);
        legacyCommit = { leaseId, fence: locked.fence };
        const localMatches = stored?.version === 1 && (stored.revision === locked.revision
          || stored.pending?.objectPath === locked.objectPath && stored.pending?.sha256 === locked.sha256);
        if (stored?.dirty && !discard && !localMatches) conflict();
        const local = join(directory, "workspace.munhae");
        if (localMatches && stored.dirty && !discard && existsSync(local)) repo = openProject(local, { onlineCache: true });
        else {
          const bytes = await deps.legacy.download(locked); deps.assertUser(onlineProjectAccount(project));
          const archive = join(staging, "legacy.munhaepkg"), incoming = join(staging, "legacy.munhae");
          writeFileSync(archive, bytes, { mode: 0o600 }); await extractZip(archive, incoming);
          repo = openProject(incoming, { onlineCache: true });
        }
      } else if (stored?.dirty && !discard && existsSync(join(directory, "workspace.munhae"))) {
        repo = openProject(join(directory, "workspace.munhae"), { onlineCache: true });
      } else {
        repo = createProject({ title: project.title, parentDir: staging, projectId: project.id }).handle;
        const root = repo.getHome().documents.find(document => document.isMaster);
        if (root && project.description) { const metadata = repo.getDocumentMetadata(root.id);
          repo.updateDocumentMetadata({ ...metadata, documentNodeId: root.id, expectedLockVersion: metadata.lockVersion, descriptionMd: project.description }); }
      }
      const tables = repo.exportOnlineRows();
      await uploadAssets(deps, project, repo.packagePath, tables);
      if (legacyCommit) await deps.legacy!.renew(project.id, legacyCommit.leaseId, legacyCommit.fence);
      const mutationId = randomUUID(), changes = diffOnlineRows(emptyOnlineRows(), tables);
      const receipt = join(directory, "initial-commit.json");
      const fd = openSync(receipt + ".tmp", "w", 0o600);
      try { writeFileSync(fd, JSON.stringify({ projectId: project.id, ownerId: onlineProjectAccount(project), mutationId, changes, legacy: legacyCommit })); fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(receipt + ".tmp", receipt);
      await deps.remote.commit(project.id, 0, mutationId, changes, legacyCommit);
      deps.assertUser(onlineProjectAccount(project));
      const initialized = await deps.remote.get(project.id);
      return initialized;
    } finally { repo?.close(); await release?.().catch(() => undefined); rmSync(staging, { recursive: true, force: true }); }
  }
  assertOperation(method: string, mutating: boolean): void {
    if (this.closed) throw new AppError("no_project", "온라인 프로젝트가 닫혔습니다.");
    this.deps.assertUser(onlineProjectAccount(this.project));
    if (this.phase === "locked") throw new AppError("online_workspace_forbidden", this.failure || "프로젝트 접근 권한을 확인해 주세요.");
    if (mutating && this.project.role === "viewer") throw new AppError("online_workspace_readonly", "열람자는 내용을 수정하거나 AI 작업을 실행할 수 없습니다.");
    if (mutating && this.project.role !== "owner" && ["confirmSource", "confirmPunctuation", "confirmTranslation", "saveProjectSettings", "updateProject"].includes(method)) throw new AppError("online_workspace_owner_required", "소유자만 최종 확정하거나 프로젝트 설정을 변경할 수 있습니다.");
    const terminal = /^(complete|finish|fail|record|storeTermCandidates|prepareAlignment|submitAlignment|checkAlignment)/.test(method);
    if (mutating && this.phase === "conflict" && !terminal) conflict();
    if (mutating) this.markDirty();
  }
  get changeGeneration(): number { return this.journal.generation; }
  markDirty(): void {
    if (this.closed) return;
    this.journal.generation++; this.journal.dirty = true; save(this.directory, this.journal);
    if (!["syncing", "conflict"].includes(this.phase)) this.phase = "pending";
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, 500); this.timer.unref();
  }
  status(): OnlineWorkspaceStatus {
    this.deps.assertUser(onlineProjectAccount(this.project));
    return { projectId: this.project.id, sessionId: this.sessionId, state: this.phase, revision: this.journal.revision,
      dirty: this.journal.dirty, writable: !this.closed && !["conflict", "locked"].includes(this.phase) && this.project.role !== "viewer", role: this.project.role, message: this.failure ?? (this.project.role === "viewer" ? "열람 전용 프로젝트입니다." : null),
      updatedAt: this.updatedAt, realtimeConnected: this.connected };
  }
  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.serial.then(async () => { if (!this.closed) { this.deps.assertUser(onlineProjectAccount(this.project)); await action(); } });
    this.serial = result.catch(error => { this.failure = message(error); this.phase = (error as { code?: string }).code === "online_workspace_conflict" ? "conflict" : ["online_workspace_forbidden", "forbidden", "not_found"].includes((error as { code?: string }).code ?? "") ? "locked" : "error"; });
    return result;
  }
  private async refreshAccess(): Promise<void> {
    if (!this.deps.refreshProject) return;
    const next = await this.deps.refreshProject(this.project.id);
    this.deps.assertUser(onlineProjectAccount(this.project));
    if (onlineProjectAccount(next) !== onlineProjectAccount(this.project) || next.ownerId !== this.project.ownerId) throw new AppError("online_workspace_forbidden", "프로젝트 계정이 변경되었습니다.");
    this.project.role = next.role;
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    return this.enqueue(async () => {
      if (this.phase === "locked" || this.journal.dirty || this.journal.pending) await this.refreshAccess();
      if (this.project.role === "viewer" && (this.journal.dirty || this.journal.pending)) throw new AppError("online_workspace_readonly", "열람 권한으로 변경되어 저장할 수 없습니다. 작업은 복구본으로 보존할 수 있습니다.");
      if (this.phase === "conflict") conflict();
      while (this.journal.dirty || this.journal.pending) {
        this.phase = "syncing";
        if (!this.journal.pending) {
          const changes = diffOnlineRows(this.journal.base, this.repo.exportOnlineRows());
          if (!changes.length) { this.journal.dirty = false; save(this.directory, this.journal); break; }
          this.journal.pending = { mutationId: randomUUID(), revision: this.journal.revision, generation: this.journal.generation, changes };
          save(this.directory, this.journal);
        }
        const pending = this.journal.pending;
        const next = applyOnlineRowChanges(this.journal.base, pending.changes);
        // Only new or changed attachment locations need uploads; immutable keys allow safe retries.
        const assetChanges = pending.changes.filter(change => change.table === "src_asset_locations" && change.after).map(change => change.after!);
        await uploadAssets(this.deps, this.project, this.packagePath, { ...next, src_asset_locations: assetChanges });
        const accepted = await this.deps.remote.commit(this.project.id, pending.revision, pending.mutationId, pending.changes);
        this.deps.assertUser(onlineProjectAccount(this.project));
        this.journal.base = next; this.journal.revision = accepted.revision; this.updatedAt = accepted.updatedAt;
        this.journal.dirty = this.journal.generation !== pending.generation; this.journal.pending = null; save(this.directory, this.journal);
      }
      this.phase = "synced"; this.failure = null;
    });
  }
  pull(reason: ProjectChangeEvent["reason"] = "resync"): Promise<void> {
    return this.enqueue(async () => {
      await this.refreshAccess();
      // Let an in-flight or uncertain local mutation resolve its UUID first. Its own
      // Realtime notice must never be misclassified as a competing writer.
      if (this.journal.dirty || this.journal.pending) return;
      if (!await this.deps.remote.changes(this.project.id, this.journal.revision)) return;
      const head = await this.deps.remote.get(this.project.id); this.deps.assertUser(onlineProjectAccount(this.project));
      if (head.dataProjectId !== this.repo.projectId) throw new AppError("online_workspace_integrity", "온라인 프로젝트 식별자가 변경되었습니다.");
      if (head.revision <= this.journal.revision) return;
      await downloadAssets(this.deps, this.project, this.packagePath, head.tables);
      if (this.journal.dirty || this.journal.pending) return;
      if (this.closed) return;
      this.deps.assertUser(onlineProjectAccount(this.project));
      const changes = diffOnlineRows(this.journal.base, head.tables);
      this.repo.applyOnlineRows(head.tables); this.journal.base = head.tables; this.journal.revision = head.revision;
      this.updatedAt = head.updatedAt; save(this.directory, this.journal); this.phase = "synced"; this.failure = null;
      this.deps.onChange?.({ projectId: this.repo.projectId, accountId: onlineProjectAccount(this.project), sessionId: this.sessionId,
        revision: head.revision, reason,
        documentIds: [...new Set(changes.flatMap(change => { const row = change.after ?? change.before;
          return typeof row?.document_node_id === "string" ? [row.document_node_id] : change.table === "document_nodes" && typeof row?.id === "string" ? [row.id] : []; }))].slice(0, 10000),
        scopes: [...new Set(changes.map(change => {
          const table = change.table;
          if (table === "document_nodes") return "documents";
          if (table.startsWith("src_")) return "source";
          if (table.startsWith("punctuation_")) return "punctuation";
          if (table.startsWith("translation_")) return "translation";
          if (table.startsWith("term_")) return "terms";
          if (/material|context|uncertainty/.test(table)) return "materials";
          if (/comment|reading_annotation/.test(table)) return "comments";
          if (/chat|llm|alignment/.test(table)) return "aiRuns";
          if (/event|artifact/.test(table)) return "history";
          return "project";
        }))] });
    });
  }
  async close(keepUnsynced = false): Promise<void> {
    if (this.closed) return;
    if (!keepUnsynced) await this.flush();
    if (this.timer) clearTimeout(this.timer); if (this.heartbeat) clearInterval(this.heartbeat);
    this.stopWatch?.(); this.stopWatch = null;
    this.closed = true; await this.serial; this.repo.close();
  }
}
