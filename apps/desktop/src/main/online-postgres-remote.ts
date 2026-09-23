import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { diffOnlineRows, ONLINE_TABLE_METADATA, type OnlineTableData, type OnlineRowChange } from "@munhae/db-sqlite";
import { AppError } from "./errors";
import { onlineProjectId } from "./online-projects";

export type OnlineDataHead = { projectId: string; dataProjectId: string | null; revision: number; updatedAt: string; tables: OnlineTableData };
export type OnlineCommit = { revision: number; updatedAt: string };
export type AuthorizedRequest = <T>(action: (client: SupabaseClient, userId: string) => Promise<T>) => Promise<T>;
export const emptyOnlineRows = (): OnlineTableData => Object.fromEntries(ONLINE_TABLE_METADATA.map(table => [table.name, []]));
const invalid = (): never => { throw new AppError("online_workspace_response_invalid", "온라인 데이터 형식이 일치하지 않습니다. 앱을 업데이트한 뒤 다시 열어 주세요."); };
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const assetHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
function fail(error: { code?: string; message?: string; status?: number; statusCode?: string | number }): never {
  if (/ONLINE_DATA_LEGACY_LEASE_LOST/.test(error.message ?? "")) throw new AppError("online_workspace_lease_lost", "이전 온라인 작업의 편집 연결이 만료되었습니다. 이 기기의 작업을 보존한 뒤 다시 연결하세요.");
  if (error.code === "40001" || /ONLINE_DATA_CONFLICT/.test(error.message ?? "")) throw new AppError("online_workspace_conflict", "다른 기기에서 먼저 저장했습니다. 이 기기의 작업을 보존한 뒤 최신 버전을 열어 주세요.");
  if (/COLLAB_CONFIRM_OWNER_REQUIRED/.test(error.message ?? "")) throw new AppError("online_workspace_owner_required", "소유자만 확정된 내용을 변경하거나 최종 확정할 수 있습니다.");
  if (/COLLAB_WRITE_REQUIRED/.test(error.message ?? "")) throw new AppError("online_workspace_readonly", "현재 계정에 편집 권한이 없습니다. 작업은 이 기기에 보존되어 있습니다.");
  if (error.code === "42501") throw new AppError("online_workspace_forbidden", "이 온라인 프로젝트에 접근할 수 없습니다.");
  if (["PGRST301", "PGRST302", "PGRST303"].includes(error.code ?? "")) throw new AppError("session_not_found", "로그인 세션이 만료되었습니다. 다시 로그인하세요.");
  if (["PGRST202", "PGRST205", "42P01"].includes(error.code ?? "")) throw new AppError("online_workspace_unavailable", "온라인 데이터베이스를 준비 중입니다. 잠시 후 다시 시도하세요.");
  if (Number(error.statusCode ?? error.status) === 413 || ["EntityTooLarge", "PayloadTooLarge", "FileSizeLimitExceeded"].includes(error.code ?? "")) throw new AppError("online_workspace_too_large", "첨부 파일은 파일당 50MiB 이내여야 합니다.");
  if (/^23/.test(error.code ?? "") || error.code === "22023") throw new AppError("online_workspace_invalid_data", "서버에서 문서의 연결 관계를 검증하지 못했습니다. 이 기기의 작업은 보존되어 있습니다.");
  throw new AppError("online_workspace_request_failed", "온라인 저장 요청을 완료하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.");
}
function commitResult(data: unknown): OnlineCommit {
  const row = data as Record<string, unknown> | null;
  if (!row || Array.isArray(row) || !natural(row.revision) || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) return invalid();
  return { revision: row.revision, updatedAt: row.updated_at };
}
/** Canonical project content is normalized PostgreSQL rows. Storage contains only individual attachments. */
export class OnlinePostgresRemote {
  constructor(private authorized: AuthorizedRequest) {}
  private request<T>(action: (client: SupabaseClient, userId: string) => Promise<T>): Promise<T> {
    return this.authorized(action).catch(error => { if (error instanceof AppError) throw error; return fail(error ?? {}); });
  }
  get(projectId: string): Promise<OnlineDataHead> {
    const id = onlineProjectId(projectId);
    return this.request(async client => {
      const { data, error } = await client.rpc("get_online_project_data", { p_project_id: id });
      if (error) fail(error);
      const head = commitResult(data);
      if (data.project_id !== id || data.schema_version !== 10 || !(data.data_project_id === null
        || typeof data.data_project_id === "string" && data.data_project_id.length > 0 && data.data_project_id.length <= 200)) invalid();
      try { diffOnlineRows(emptyOnlineRows(), data.tables); } catch { invalid(); }
      const tables = data.tables as OnlineTableData;
      if (head.revision === 0 ? data.data_project_id !== null || Object.values(tables).some(rows => rows.length)
        : data.data_project_id === null || tables.core_projects!.length !== 1 || tables.core_projects![0]!.id !== data.data_project_id
          || ONLINE_TABLE_METADATA.some(table => table.columns.includes("project_id") && tables[table.name]!.some(row => row.project_id !== data.data_project_id))) invalid();
      return { ...head, projectId: id, dataProjectId: data.data_project_id, tables: data.tables };
    });
  }
  commit(projectId: string, revision: number, mutationId: string, changes: OnlineRowChange[], legacy?: { leaseId: string; fence: number }): Promise<OnlineCommit> {
    const id = onlineProjectId(projectId), mutation = onlineProjectId(mutationId);
    if (!natural(revision) || revision === Number.MAX_SAFE_INTEGER) invalid();
    const leaseId = legacy ? onlineProjectId(legacy.leaseId) : null;
    if (legacy && (!natural(legacy.fence) || legacy.fence < 1)) invalid();
    return this.request(async client => {
      const { data, error } = await client.rpc("commit_online_project_data", { p_project_id: id,
        p_expected_revision: revision, p_mutation_id: mutation, p_schema_version: 10, p_changes: changes,
        ...(legacy ? { p_legacy_lease_id: leaseId, p_legacy_fence: legacy.fence } : {}) });
      if (error) fail(error);
      const result = commitResult(data);
      if (result.revision !== revision + 1) invalid();
      return result;
    });
  }
  /** Metadata notices can be missed; a full consistent RPC snapshot also repairs any gap. */
  async changes(projectId: string, revision: number): Promise<boolean> {
    const id = onlineProjectId(projectId);
    if (!natural(revision)) invalid();
    return this.request(async client => {
      const { data, error } = await client.rpc("get_online_project_changes", { p_project_id: id, p_after_revision: revision });
      if (error) fail(error);
      const head = commitResult(data);
      if (head.revision < revision) invalid();
      return head.revision > revision;
    });
  }
  uploadAsset(projectId: string, bytes: Uint8Array, ownerId?: string): Promise<string> {
    const id = onlineProjectId(projectId);
    if (!(bytes instanceof Uint8Array)) throw new AppError("invalid_input", "첨부 파일을 확인하세요.");
    if (bytes.byteLength > MAX_ASSET_BYTES) throw new AppError("online_workspace_too_large", "첨부 파일은 파일당 50MiB 이내여야 합니다.");
    // Hold immutable bytes while authentication/network operations yield.
    const snapshot = Buffer.from(bytes), sha = assetHash(snapshot);
    return this.request(async (client, userId) => {
      const path = `${ownerId ? onlineProjectId(ownerId) : userId}/${id}/${sha}`;
      const { error } = await client.storage.from("online-project-assets").upload(path, snapshot, { upsert: false, contentType: "application/octet-stream" });
      if (error && !/already exists|duplicate/i.test(error.message)) fail(error);
      if (error) {
        const result = await client.storage.from("online-project-assets").download(path);
        if (result.error) fail(result.error);
        if (!result.data || result.data.size !== snapshot.byteLength || assetHash(new Uint8Array(await result.data.arrayBuffer())) !== sha) invalid();
      }
      return sha;
    });
  }
  downloadAsset(projectId: string, sha: string, ownerId?: string): Promise<Uint8Array> {
    const id = onlineProjectId(projectId);
    if (!/^[0-9a-f]{64}$/.test(sha)) invalid();
    return this.request(async (client, userId) => {
      const { data, error } = await client.storage.from("online-project-assets").download(`${ownerId ? onlineProjectId(ownerId) : userId}/${id}/${sha}`);
      if (error) fail(error);
      if (!data || data.size > MAX_ASSET_BYTES) invalid();
      const bytes = new Uint8Array(await data.arrayBuffer());
      if (assetHash(bytes) !== sha) invalid();
      return bytes;
    });
  }
}
