import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "./errors";
import { onlineProjectId } from "./online-projects";

export const ONLINE_WORKSPACE_BUCKET = "online-project-workspaces";
export const ONLINE_WORKSPACE_MAX_BYTES = 50 * 1024 * 1024;
export const ONLINE_WORKSPACE_LEASE_SECONDS = 120;
export const ONLINE_WORKSPACE_HEARTBEAT_MS = 30_000;

export interface OnlineWorkspaceHead {
  projectId: string;
  revision: number;
  objectPath: string | null;
  sha256: string | null;
  byteSize: number | null;
  leaseId: string | null;
  fence: number;
  leaseExpiresAt: string | null;
  updatedAt: string;
}
export type Head = OnlineWorkspaceHead;

export interface OnlineWorkspaceCommitInput {
  projectId: string;
  leaseId: string;
  fence: number;
  expectedRevision: number;
  objectPath: string;
  sha256: string;
  byteSize: number;
}

type AuthorizedRequest = <T>(action: (client: SupabaseClient, userId: string) => Promise<T>) => Promise<T>;
type RemoteError = { code?: string; message?: string; status?: number; statusCode?: string | number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HEAD_COLUMNS = "project_id,owner_id,revision,object_path,sha256,byte_size,lease_id,fence,lease_expires_at,updated_at";

function fail(error: RemoteError): never {
  const message = error.message ?? "";
  const code = error.code ?? "";
  const status = Number(error.statusCode ?? error.status);
  if (message.includes("ONLINE_WORKSPACE_LOCKED")) {
    throw new AppError("online_workspace_locked", "다른 창이나 기기에서 이 프로젝트를 편집하고 있습니다. 해당 작업을 닫은 뒤 다시 여세요.");
  }
  if (message.includes("ONLINE_WORKSPACE_LEASE_LOST")) {
    throw new AppError("online_workspace_lease_lost", "온라인 편집 연결이 만료되었습니다. 이 기기의 변경 내용을 보존한 뒤 다시 연결하세요.");
  }
  if (message.includes("ONLINE_WORKSPACE_CONFLICT") || code === "40001") {
    throw new AppError("online_workspace_conflict", "서버에 새로운 버전이 있습니다. 현재 변경 내용을 보존한 뒤 최신 버전을 다시 여세요.");
  }
  if (["PGRST301", "PGRST302", "PGRST303"].includes(code) || status === 401) {
    throw new AppError("session_not_found", "로그인 세션이 만료되었습니다. 다시 로그인하세요.");
  }
  if (code === "42501" || status === 403) {
    throw new AppError("online_workspace_forbidden", "이 온라인 프로젝트에 접근할 수 없거나 편집 연결이 만료되었습니다.");
  }
  if (status === 413 || ["EntityTooLarge", "PayloadTooLarge", "FileSizeLimitExceeded"].includes(code)
    || /(?:exceed.*(?:size|limit)|maximum allowed size)/i.test(message)) {
    throw new AppError("online_workspace_too_large", "온라인 프로젝트 저장 파일은 50MiB 이내여야 합니다. 파일 크기와 서버 저장 한도를 확인하세요.");
  }
  if (["PGRST202", "PGRST205", "42P01", "NoSuchBucket"].includes(code) || /bucket not found/i.test(message)) {
    throw new AppError("online_workspace_unavailable", "온라인 작업 공간 연결을 준비 중입니다. 잠시 후 다시 시도하세요.");
  }
  if (message.includes("ONLINE_WORKSPACE_CHECKPOINT_MISSING")) {
    throw new AppError("online_workspace_checkpoint_missing", "저장 파일 업로드를 확인하지 못했습니다. 이 기기의 변경 내용을 유지하고 다시 저장하세요.");
  }
  if (message.includes("ONLINE_WORKSPACE_CHECKPOINT_INVALID") || message.includes("ONLINE_WORKSPACE_INVALID_")) {
    throw new AppError("online_workspace_checkpoint_invalid", "온라인 저장 파일 정보를 확인하지 못했습니다. 다시 저장하세요.");
  }
  throw new AppError("online_workspace_request_failed", "온라인 프로젝트 요청을 완료하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.");
}

function natural(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value) && Number.isFinite(Date.parse(value));
}
function invalidResponse(): never {
  throw new AppError("online_workspace_response_invalid", "온라인 작업 공간 정보를 확인하지 못했습니다. 다시 불러오세요.");
}
function checkFence(value: number): number {
  if (!natural(value, 1)) throw new AppError("invalid_input", "온라인 편집 연결 정보를 확인하세요.");
  return value;
}
function checkBytes(value: number): number {
  if (!natural(value, 1) || value > ONLINE_WORKSPACE_MAX_BYTES) {
    throw new AppError("online_workspace_too_large", "온라인 프로젝트 저장 파일은 50MiB 이내여야 합니다.");
  }
  return value;
}
function pathFence(value: unknown, userId: string, projectId: string): number | null {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== userId || parts[1] !== projectId
    || !/^[1-9][0-9]*$/.test(parts[2]!) || !parts[3]!.endsWith(".munhaepkg")
    || !UUID.test(parts[3]!.slice(0, -".munhaepkg".length))) return null;
  const fence = Number(parts[2]);
  return natural(fence, 1) ? fence : null;
}

function rowToHead(value: unknown, projectId: string, userId: string): OnlineWorkspaceHead {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
  const row = value as Record<string, unknown>;
  if (row.project_id !== projectId || row.owner_id !== userId
    || !natural(row.revision) || !natural(row.fence) || !timestamp(row.updated_at)
    || !(row.lease_id === null || typeof row.lease_id === "string" && UUID.test(row.lease_id))
    || !(row.lease_expires_at === null || timestamp(row.lease_expires_at))
    || (row.lease_id === null) !== (row.lease_expires_at === null)
    || row.lease_id !== null && row.fence < 1) invalidResponse();
  if (row.revision === 0) {
    if (row.object_path !== null || row.sha256 !== null || row.byte_size !== null) invalidResponse();
  } else {
    const objectFence = pathFence(row.object_path, userId, projectId);
    if (objectFence === null || objectFence > row.fence || typeof row.sha256 !== "string" || !SHA256.test(row.sha256)
      || !natural(row.byte_size, 1) || row.byte_size > ONLINE_WORKSPACE_MAX_BYTES) invalidResponse();
  }
  return {
    projectId, revision: row.revision, objectPath: row.object_path as string | null,
    sha256: row.sha256 as string | null, byteSize: row.byte_size as number | null,
    leaseId: row.lease_id as string | null, fence: row.fence,
    leaseExpiresAt: row.lease_expires_at as string | null, updatedAt: row.updated_at,
  };
}

async function requireOwner(client: SupabaseClient, userId: string, projectId: string): Promise<void> {
  const { data, error } = await client.from("online_projects").select("id,owner_id")
    .eq("id", projectId).eq("owner_id", userId).maybeSingle();
  if (error) fail(error);
  if (!data || data.id !== projectId || data.owner_id !== userId) {
    throw new AppError("online_workspace_forbidden", "이 온라인 프로젝트를 찾을 수 없거나 접근 권한이 없습니다.");
  }
}

async function getHead(client: SupabaseClient, userId: string, projectId: string): Promise<OnlineWorkspaceHead | null> {
  const { data, error } = await client.from("online_project_workspaces").select(HEAD_COLUMNS)
    .eq("project_id", projectId).eq("owner_id", userId).maybeSingle();
  if (error) fail(error);
  return data ? rowToHead(data, projectId, userId) : null;
}

async function downloadBytes(client: SupabaseClient, objectPath: string, size: number, sha256: string): Promise<Uint8Array> {
  const { data, error } = await client.storage.from(ONLINE_WORKSPACE_BUCKET).download(objectPath);
  if (error) fail(error);
  if (!data || data.size !== size || data.size > ONLINE_WORKSPACE_MAX_BYTES) {
    throw new AppError("online_workspace_checkpoint_invalid", "온라인 저장 파일의 크기가 일치하지 않습니다. 이 기기의 기존 자료를 유지합니다.");
  }
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new AppError("online_workspace_checkpoint_invalid", "온라인 저장 파일을 검증하지 못했습니다. 이 기기의 기존 자료를 유지합니다.");
  }
  return bytes;
}

/** Main-process only. Every request uses the guarded current account, never a
 * renderer-provided token or service key. Storage objects are immutable. */
export class OnlineWorkspaceRemote {
  constructor(private readonly authorized: AuthorizedRequest) {}

  private request<T>(action: (client: SupabaseClient, userId: string) => Promise<T>): Promise<T> {
    return this.authorized(action).catch((error: unknown) => {
      if (error instanceof AppError) throw error;
      fail(error && typeof error === "object" ? error as RemoteError : {});
    });
  }

  get(projectId: string): Promise<OnlineWorkspaceHead | null> {
    const id = onlineProjectId(projectId);
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      return getHead(client, userId, id);
    });
  }

  acquire(projectId: string, leaseId: string): Promise<OnlineWorkspaceHead> {
    const id = onlineProjectId(projectId), lease = onlineProjectId(leaseId);
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      const { data, error } = await client.rpc("acquire_online_workspace", { p_project_id: id, p_lease_id: lease }).single();
      if (error) fail(error);
      const head = rowToHead(data, id, userId);
      if (head.leaseId !== lease) invalidResponse();
      return head;
    });
  }

  renew(projectId: string, leaseId: string, fence: number): Promise<OnlineWorkspaceHead> {
    const id = onlineProjectId(projectId), lease = onlineProjectId(leaseId), epoch = checkFence(fence);
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      const { data, error } = await client.rpc("renew_online_workspace", { p_project_id: id, p_lease_id: lease, p_fence: epoch }).single();
      if (error) fail(error);
      const head = rowToHead(data, id, userId);
      if (head.leaseId !== lease || head.fence !== epoch) invalidResponse();
      return head;
    });
  }

  release(projectId: string, leaseId: string, fence: number): Promise<void> {
    const id = onlineProjectId(projectId), lease = onlineProjectId(leaseId), epoch = checkFence(fence);
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      const { data, error } = await client.rpc("release_online_workspace", { p_project_id: id, p_lease_id: lease, p_fence: epoch });
      if (error) fail(error);
      if (typeof data !== "boolean") invalidResponse();
    });
  }

  upload(projectId: string, leaseId: string, fence: number, checkpointId: string, bytes: Uint8Array): Promise<string> {
    const id = onlineProjectId(projectId), lease = onlineProjectId(leaseId);
    const epoch = checkFence(fence), checkpoint = onlineProjectId(checkpointId);
    if (!(bytes instanceof Uint8Array)) throw new AppError("invalid_input", "온라인 저장 파일을 확인하세요.");
    checkBytes(bytes.byteLength);
    const snapshot = Buffer.from(bytes);
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      const head = await getHead(client, userId, id);
      if (!head || head.leaseId !== lease || head.fence !== epoch) {
        throw new AppError("online_workspace_lease_lost", "온라인 편집 연결이 만료되었습니다. 현재 변경 내용을 유지하고 다시 연결하세요.");
      }
      const objectPath = `${userId}/${id}/${epoch}/${checkpoint}.munhaepkg`;
      const { data, error } = await client.storage.from(ONLINE_WORKSPACE_BUCKET).upload(objectPath, snapshot, {
        upsert: false, contentType: "application/zip", cacheControl: "0", metadata: { lease_id: lease },
      });
      if (error) {
        if (["Duplicate", "ResourceAlreadyExists", "KeyAlreadyExists"].includes((error as RemoteError).code ?? "")
          || /already exists/i.test(error.message)) {
          // The upload may have succeeded before its HTTP response was lost.
          // Only an exact byte-for-byte retry can reuse the immutable key.
          await downloadBytes(client, objectPath, snapshot.byteLength, createHash("sha256").update(snapshot).digest("hex"));
          return objectPath;
        }
        fail(error);
      }
      if (!data || data.path !== objectPath) invalidResponse();
      return objectPath;
    });
  }

  download(head: OnlineWorkspaceHead): Promise<Uint8Array> {
    const id = onlineProjectId(head.projectId);
    if (head.objectPath === null || head.sha256 === null || !SHA256.test(head.sha256) || head.byteSize === null) invalidResponse();
    const size = checkBytes(head.byteSize), objectPath = head.objectPath, sha256 = head.sha256;
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      if (pathFence(objectPath, userId, id) === null) invalidResponse();
      return downloadBytes(client, objectPath, size, sha256);
    });
  }

  commit(input: OnlineWorkspaceCommitInput): Promise<OnlineWorkspaceHead> {
    const id = onlineProjectId(input.projectId), lease = onlineProjectId(input.leaseId), epoch = checkFence(input.fence);
    const size = checkBytes(input.byteSize), revision = input.expectedRevision;
    if (!natural(revision) || revision >= Number.MAX_SAFE_INTEGER || !SHA256.test(input.sha256)) {
      throw new AppError("invalid_input", "온라인 저장 버전과 파일 정보를 확인하세요.");
    }
    const objectPath = input.objectPath, sha256 = input.sha256;
    return this.request(async (client, userId) => {
      await requireOwner(client, userId, id);
      if (pathFence(objectPath, userId, id) !== epoch) throw new AppError("invalid_input", "온라인 저장 경로를 확인하세요.");
      const { data, error } = await client.rpc("commit_online_workspace", {
        p_project_id: id, p_lease_id: lease, p_fence: epoch, p_expected_revision: revision,
        p_object_path: objectPath, p_sha256: sha256, p_byte_size: size,
      }).single();
      if (error) fail(error);
      const head = rowToHead(data, id, userId);
      if (head.objectPath !== objectPath || head.sha256 !== sha256 || head.byteSize !== size || head.revision !== revision + 1) invalidResponse();
      return head;
    });
  }
}
