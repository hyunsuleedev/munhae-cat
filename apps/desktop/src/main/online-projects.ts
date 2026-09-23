import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateOnlineProjectInput, OnlineProject, ProjectSharing, ProjectInvitation } from "../shared/online-projects";
import { AppError } from "./errors";

type AuthorizedRequest = <T>(action: (client: SupabaseClient, userId: string) => Promise<T>) => Promise<T>;
const PAGE_SIZE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function onlineProjectId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AppError("invalid_input", "온라인 프로젝트 정보를 확인하세요.");
  return value.toLowerCase();
}

export function createOnlineProjectInput(value: unknown): CreateOnlineProjectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_input", "프로젝트 정보를 입력하세요.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["title", "description", "requestId"].includes(key))) throw new AppError("invalid_input", "허용되지 않은 프로젝트 정보입니다.");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title || Array.from(title).length > 160 || /[\r\n\0]/u.test(title)) throw new AppError("invalid_input", "프로젝트 이름은 한 줄로 1~160자 입력하세요.");
  if (input.description !== undefined && typeof input.description !== "string") throw new AppError("invalid_input", "프로젝트 설명을 확인하세요.");
  const description = (input.description as string | undefined)?.trim() ?? "";
  if (Array.from(description).length > 4000 || description.includes("\0")) throw new AppError("invalid_input", "프로젝트 설명은 4,000자 이내로 입력하세요.");
  return { title, description, requestId: onlineProjectId(input.requestId) };
}

export function failOnlineProject(error: { code?: string; message?: string }): never {
  const reasons: Record<string, string> = {
    COLLAB_MEMBER_LIMIT: "소유자와 수락 대기 초대를 포함해 최대 5명까지 참여할 수 있습니다.",
    COLLAB_PREMIUM_REQUIRED: "프로젝트 소유자의 Premium 구독이 필요합니다.",
    COLLAB_ALREADY_MEMBER: "이미 프로젝트에 참여 중인 계정입니다.",
    COLLAB_INVITE_EXISTS: "이미 대기 중인 초대가 있습니다. 기존 초대를 취소한 뒤 다시 초대하세요.",
    COLLAB_INVITE_EXPIRED: "만료되었거나 취소된 초대입니다.",
    COLLAB_INVITE_NOT_FOUND: "초대받은 이메일로 인증된 계정에서 수락해 주세요.",
    COLLAB_OPEN_PROJECT_FIRST: "프로젝트를 한 번 연 뒤 멤버를 초대하세요.",
    COLLAB_OWNER_REQUIRED: "소유자만 멤버를 관리할 수 있습니다.",
  };
  for (const [code, message] of Object.entries(reasons)) if (error.message?.includes(code)) throw new AppError(code.toLowerCase(), message);
  if (error.code === "23505") throw new AppError("online_project_conflict", "같은 생성 요청의 내용이 달라졌습니다. 이름과 설명을 확인하고 다시 시도하세요.");
  if (["PGRST301", "PGRST302", "PGRST303"].includes(error.code ?? "")) throw new AppError("session_not_found", "로그인 세션이 만료되었습니다. 다시 로그인하세요.");
  if (error.code === "42501") throw new AppError("forbidden", "이 온라인 프로젝트에 접근할 수 없습니다.");
  if (["PGRST202", "PGRST205", "42P01"].includes(error.code ?? "")) throw new AppError("online_projects_unavailable", "온라인 프로젝트 연결을 준비 중입니다. 잠시 후 다시 시도하세요.");
  throw new AppError("online_project_request_failed", "온라인 프로젝트 요청을 완료하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.");
}

function rowToProject(value: unknown, userId: string): OnlineProject {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || typeof row.id !== "string" || !UUID.test(row.id)
    || typeof row.owner_id !== "string" || !UUID.test(row.owner_id) ||
    !(row.owner_id === userId ? !row.role || row.role === "owner" : ["editor", "viewer"].includes(String(row.role))) || typeof row.title !== "string" || typeof row.description !== "string"
    || typeof row.created_at !== "string" || !TIMESTAMP.test(row.created_at)
    || typeof row.updated_at !== "string" || !TIMESTAMP.test(row.updated_at)) {
    throw new AppError("online_project_response_invalid", "온라인 프로젝트 정보를 확인하지 못했습니다. 다시 불러오세요.");
  }
  return { id: row.id, ownerId: row.owner_id as string, accountId: userId, title: row.title, description: row.description,
    createdAt: row.created_at, updatedAt: row.updated_at, storageMode: "online", role: row.owner_id === userId ? "owner" : row.role as "editor" | "viewer" };
}

export class OnlineProjectsService {
  constructor(private readonly authorized: AuthorizedRequest) {}

  create(input: unknown): Promise<OnlineProject> {
    const value = createOnlineProjectInput(input);
    return this.authorized(async (client, userId) => {
      const result = await client.rpc("create_online_project", {
        p_title: value.title, p_description: value.description, p_request_id: value.requestId,
      }).single();
      if (result.error) failOnlineProject(result.error);
      if ((result.data as Record<string, unknown> | null)?.owner_id !== userId) throw new AppError("online_project_response_invalid", "프로젝트 소유자가 일치하지 않습니다.");
      return rowToProject(result.data, userId);
    });
  }

  get(input: unknown): Promise<OnlineProject> {
    const id = onlineProjectId(input);
    return this.authorized(async (client, userId) => {
      const result = await client.rpc("get_online_project_access", { p_project_id: id });
      if (result.error) failOnlineProject(result.error);
      if (!result.data || Array.isArray(result.data)) throw new AppError("not_found", "온라인 프로젝트를 찾을 수 없거나 접근 권한이 없습니다.");
      return rowToProject(result.data, userId);
    });
  }

  list(): Promise<OnlineProject[]> {
    return this.authorized(async (client, userId) => {
      const projects: OnlineProject[] = [];
      let cursor: OnlineProject | undefined;
      while (true) {
        const result = await client.rpc("list_online_projects", {
          p_before_time: cursor?.createdAt ?? null, p_before_id: cursor?.id ?? null,
        });
        if (result.error) failOnlineProject(result.error);
        if (!Array.isArray(result.data)) throw new AppError("online_project_response_invalid", "온라인 프로젝트 목록을 확인하지 못했습니다.");
        const page = result.data.map(row => rowToProject(row, userId));
        projects.push(...page);
        if (page.length < PAGE_SIZE) return projects;
        const next = page.at(-1)!;
        if (next.id === cursor?.id) throw new AppError("online_project_response_invalid", "온라인 프로젝트 목록을 다시 불러오세요.");
        cursor = next;
      }
    });
  }

  private rpc<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.authorized(async client => {
      const result = await client.rpc(name, params);
      if (result.error) failOnlineProject(result.error);
      return result.data as T;
    });
  }
  sharing(input: unknown): Promise<ProjectSharing> { return this.rpc("get_online_project_sharing", { p_project_id: onlineProjectId(input) }); }
  invitations(): Promise<ProjectInvitation[]> { return this.rpc("list_online_project_invitations"); }
  invite(input: unknown): Promise<string> {
    const value = strictObject(input, ["projectId", "email", "role"]);
    const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AppError("invalid_input", "초대할 이메일 주소를 확인하세요.");
    return this.rpc("invite_online_project_member", { p_project_id: onlineProjectId(value.projectId), p_email: email, p_role: memberRole(value.role) });
  }
  respond(input: unknown): Promise<string> {
    const value = strictObject(input, ["invitationId", "accept"]);
    if (typeof value.accept !== "boolean") throw new AppError("invalid_input", "초대 응답을 확인하세요.");
    return this.rpc("respond_online_project_invitation", { p_invitation_id: onlineProjectId(value.invitationId), p_accept: value.accept });
  }
  cancelInvitation(input: unknown): Promise<void> { return this.rpc("cancel_online_project_invitation", { p_invitation_id: onlineProjectId(input) }); }
  updateMember(input: unknown): Promise<void> {
    const value = strictObject(input, ["projectId", "userId", "role"]);
    return this.rpc("update_online_project_member", { p_project_id: onlineProjectId(value.projectId), p_user_id: onlineProjectId(value.userId), p_role: value.role === null ? null : memberRole(value.role) });
  }
}
function strictObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new AppError("invalid_input", "공유 요청을 확인하세요.");
  return input as Record<string, unknown>;
}
function memberRole(value: unknown): "editor" | "viewer" {
  if (value !== "editor" && value !== "viewer") throw new AppError("invalid_input", "편집자 또는 열람자를 선택하세요.");
  return value;
}
