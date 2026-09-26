import type { SupabaseClient } from "@supabase/supabase-js";
import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import {
  isCommunityCategory,
  validateCommunityPost,
  validateCommunityText,
  type CommunityComment,
  type CommunityFeed,
  type CommunityMember,
  type CommunityPost,
  type CommunityPostInput,
  type CommunityReport,
  type CommunityThread,
} from "../shared/community";
import { withAuthenticatedClient } from "./auth";
import { AppError } from "./errors";

type AuthenticatedAccess = <T>(action: (client: SupabaseClient, userId: string) => Promise<T>) => Promise<T>;
type Row = Record<string, unknown>;
type DbError = { code?: string } | null;

const POST_SELECT = "*,community_profiles!community_posts_author_id_fkey(display_name),community_comments(count)";
const COMMENT_SELECT = "*,community_profiles!community_comments_author_id_fkey(display_name)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same wording as the website, so both clients explain a rejection the same way. */
function fail(error: DbError): void {
  if (!error) return;
  if (error.code === "23505") throw new AppError("community_duplicate", "이미 저장하거나 신고한 항목입니다.");
  if (error.code === "42501") throw new AppError("community_forbidden", "이 작업을 할 권한이 없습니다. 로그인 상태를 확인해 주세요.");
  if (error.code === "PGRST116") throw new AppError("not_found", "글을 찾을 수 없거나 변경 권한이 없습니다.");
  if (error.code === "23514" || error.code === "22001") throw new AppError("invalid_input", "입력 내용의 길이와 공개 범위를 확인해 주세요.");
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202") {
    throw new AppError("community_unavailable", "커뮤니티 서버 설정이 아직 완료되지 않았습니다. 잠시 후 다시 이용해 주세요.");
  }
  throw new AppError("community_unavailable", "커뮤니티 요청을 완료하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.");
}

const text = (value: unknown): string => typeof value === "string" ? value : "";
const author = (row: Row): string => text((row.community_profiles as Row | null)?.display_name) || "문해 회원";

function toPost(row: Row): CommunityPost {
  const count = (row.community_comments as Array<{ count?: unknown }> | undefined)?.[0]?.count;
  return {
    id: text(row.id),
    category: isCommunityCategory(row.category) ? row.category : "discussion",
    title: text(row.title),
    body: text(row.body),
    source: text(row.source),
    original: text(row.original),
    translation: text(row.translation),
    prompt: text(row.prompt),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    private: row.is_private === true,
    authorId: text(row.author_id),
    authorName: author(row),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    resolved: row.resolved === true,
    commentCount: typeof count === "number" ? count : 0,
  };
}

function toComment(row: Row): CommunityComment {
  return { id: text(row.id), postId: text(row.post_id), authorId: text(row.author_id), authorName: author(row), body: text(row.body), createdAt: text(row.created_at) };
}

function toRow(input: CommunityPostInput): Row {
  return {
    category: input.category, title: input.title, body: input.body, source: input.source, original: input.original,
    translation: input.translation, prompt: input.prompt, tags: input.tags, is_private: input.private,
  };
}

function id(value: unknown, label = "글"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AppError("invalid_input", `${label} 식별자를 확인하세요.`);
  return value;
}

/** Validation messages are written for people, so they cross IPC unchanged. */
function checked<T>(parse: () => T): T {
  try { return parse(); } catch (error) {
    throw new AppError("invalid_input", error instanceof Error ? error.message : "입력 내용을 확인해 주세요.");
  }
}

export class CommunityService {
  constructor(private readonly access: AuthenticatedAccess) {}

  /** Posts and comments reference community_profiles, so every writer needs one first. */
  private async ensureProfile(client: SupabaseClient): Promise<string> {
    const { data, error } = await client.rpc("community_ensure_profile");
    fail(error);
    return text(data);
  }

  async feed(): Promise<CommunityFeed> {
    return this.access(async (client, userId) => {
      // Independent reads: one round trip instead of four.
      const [name, role, posts, bookmarks] = await Promise.all([
        this.ensureProfile(client),
        client.rpc("community_is_moderator"),
        client.from("community_posts").select(POST_SELECT).order("created_at", { ascending: false }),
        client.from("community_bookmarks").select("post_id"),
      ]);
      fail(role.error);
      fail(posts.error);
      fail(bookmarks.error);
      const member: CommunityMember = { id: userId, name: name || "문해 회원", isModerator: role.data === true };
      return {
        member,
        posts: ((posts.data ?? []) as Row[]).map(toPost),
        bookmarks: ((bookmarks.data ?? []) as Row[]).map(row => text(row.post_id)).filter(Boolean),
      };
    });
  }

  async thread(postId: string): Promise<CommunityThread | null> {
    return this.access(async (client) => {
      // Comment RLS follows the post's visibility, so both reads can run together.
      const [post, comments] = await Promise.all([
        client.from("community_posts").select(POST_SELECT).eq("id", postId).maybeSingle(),
        client.from("community_comments").select(COMMENT_SELECT).eq("post_id", postId).order("created_at"),
      ]);
      fail(post.error);
      if (!post.data) return null;
      fail(comments.error);
      return { post: toPost(post.data as Row), comments: ((comments.data ?? []) as Row[]).map(toComment) };
    });
  }

  async createPost(input: CommunityPostInput): Promise<CommunityPost> {
    return this.access(async (client) => {
      await this.ensureProfile(client);
      const { data, error } = await client.from("community_posts").insert(toRow(input)).select(POST_SELECT).single();
      fail(error);
      return toPost(data as Row);
    });
  }

  async updatePost(postId: string, input: CommunityPostInput): Promise<CommunityPost> {
    return this.access(async (client) => {
      const { data, error } = await client.from("community_posts").update(toRow(input)).eq("id", postId).select(POST_SELECT).single();
      fail(error);
      return toPost(data as Row);
    });
  }

  async deletePost(postId: string): Promise<void> {
    await this.access(async (client) => {
      fail((await client.from("community_posts").delete().eq("id", postId).select("id").single()).error);
    });
  }

  async resolvePost(postId: string, resolved: boolean): Promise<void> {
    await this.access(async (client) => {
      fail((await client.from("community_posts").update({ resolved }).eq("id", postId).select("id").single()).error);
    });
  }

  async addComment(postId: string, body: string): Promise<CommunityComment> {
    return this.access(async (client) => {
      await this.ensureProfile(client);
      const { data, error } = await client.from("community_comments").insert({ post_id: postId, body }).select(COMMENT_SELECT).single();
      fail(error);
      return toComment(data as Row);
    });
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.access(async (client) => {
      fail((await client.from("community_comments").delete().eq("id", commentId).select("id").single()).error);
    });
  }

  async setBookmark(postId: string, saved: boolean): Promise<void> {
    await this.access(async (client) => {
      const result = saved
        ? await client.from("community_bookmarks").upsert({ post_id: postId }, { onConflict: "member_id,post_id", ignoreDuplicates: true })
        : await client.from("community_bookmarks").delete().eq("post_id", postId);
      fail(result.error);
    });
  }

  async report(postId: string, reason: string): Promise<void> {
    await this.access(async (client) => {
      fail((await client.from("community_reports").insert({ post_id: postId, reason })).error);
    });
  }

  /** RLS returns reports only to moderators; others receive an empty list. */
  async reports(): Promise<CommunityReport[]> {
    return this.access(async (client) => {
      const { data, error } = await client.from("community_reports").select("id,post_id,reason,created_at").order("created_at");
      fail(error);
      return ((data ?? []) as Row[]).map(row => ({ id: text(row.id), postId: text(row.post_id), reason: text(row.reason), createdAt: text(row.created_at) }));
    });
  }

  async dismissReport(reportId: string): Promise<void> {
    await this.access(async (client) => {
      fail((await client.from("community_reports").delete().eq("id", reportId).select("id").single()).error);
    });
  }
}

export const COMMUNITY_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.communityFeed,
  IPC_CHANNELS.communityThread,
  IPC_CHANNELS.communityCreatePost,
  IPC_CHANNELS.communityUpdatePost,
  IPC_CHANNELS.communityDeletePost,
  IPC_CHANNELS.communityResolvePost,
  IPC_CHANNELS.communityAddComment,
  IPC_CHANNELS.communityDeleteComment,
  IPC_CHANNELS.communitySetBookmark,
  IPC_CHANNELS.communityReport,
  IPC_CHANNELS.communityReports,
  IPC_CHANNELS.communityDismissReport,
];

const service = new CommunityService(withAuthenticatedClient);

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new AppError("invalid_input", "요청 값을 확인하세요.");
  return value;
}

export function dispatchCommunity(channel: IpcChannel, args: unknown[]): Promise<unknown> {
  const [first, second] = args;
  switch (channel) {
    case IPC_CHANNELS.communityFeed: return service.feed();
    case IPC_CHANNELS.communityThread: return service.thread(id(first));
    case IPC_CHANNELS.communityCreatePost: return service.createPost(checked(() => validateCommunityPost(first)));
    case IPC_CHANNELS.communityUpdatePost: return service.updatePost(id(first), checked(() => validateCommunityPost(second)));
    case IPC_CHANNELS.communityDeletePost: return service.deletePost(id(first));
    case IPC_CHANNELS.communityResolvePost: return service.resolvePost(id(first), flag(second));
    case IPC_CHANNELS.communityAddComment: return service.addComment(id(first), checked(() => validateCommunityText(second, "댓글", 1, 5000)));
    case IPC_CHANNELS.communityDeleteComment: return service.deleteComment(id(first, "댓글"));
    case IPC_CHANNELS.communitySetBookmark: return service.setBookmark(id(first), flag(second));
    case IPC_CHANNELS.communityReport: return service.report(id(first), checked(() => validateCommunityText(second, "신고 사유", 5, 1000)));
    case IPC_CHANNELS.communityReports: return service.reports();
    case IPC_CHANNELS.communityDismissReport: return service.dismissReport(id(first, "신고"));
    default: throw new AppError("invalid_payload", "허용되지 않은 커뮤니티 요청입니다.");
  }
}
