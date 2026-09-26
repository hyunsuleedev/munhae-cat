/**
 * Munhae community: the same Supabase tables munhaestudio.com/community uses.
 * Renderer-safe; main validates every write with the same rules as the website.
 */
export type CommunityCategory = "discussion" | "question" | "resource";

export const COMMUNITY_CATEGORIES: readonly CommunityCategory[] = ["discussion", "question", "resource"];
export const COMMUNITY_CATEGORY_LABELS: Record<CommunityCategory, string> = {
  discussion: "번역 토론",
  question: "질문·문의",
  resource: "스킬·프롬프트",
};
export const COMMUNITY_WEB_URL = "https://munhaestudio.com/community/";

export type CommunityPostInput = {
  category: CommunityCategory;
  title: string;
  body: string;
  source: string;
  original: string;
  translation: string;
  prompt: string;
  tags: string[];
  private: boolean;
};

export type CommunityPost = CommunityPostInput & {
  id: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  commentCount: number;
};

export type CommunityComment = {
  id: string;
  postId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type CommunityMember = { id: string; name: string; isModerator: boolean };
export type CommunityReport = { id: string; postId: string; reason: string; createdAt: string };
export type CommunityFeed = { member: CommunityMember; posts: CommunityPost[]; bookmarks: string[] };
export type CommunityThread = { post: CommunityPost; comments: CommunityComment[] };

export function isCommunityCategory(value: unknown): value is CommunityCategory {
  return typeof value === "string" && (COMMUNITY_CATEGORIES as readonly string[]).includes(value);
}

export function validateCommunityText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${label}을(를) 확인해 주세요.`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new Error(`${label}은(는) ${min > 0 ? `${min}자 이상, ` : ""}${max.toLocaleString()}자 이하로 입력해 주세요.`);
  }
  return text;
}

/** Mirrors the database checks so a rejected write explains which field to fix. */
export function validateCommunityPost(input: unknown): CommunityPostInput {
  const value = (input ?? {}) as Partial<Record<keyof CommunityPostInput, unknown>>;
  if (!isCommunityCategory(value.category)) throw new Error("글 유형을 선택해 주세요.");
  if (typeof value.private !== "boolean") throw new Error("공개 범위를 확인해 주세요.");
  if (value.private && value.category !== "question") throw new Error("비공개 글은 질문·문의에서만 작성할 수 있습니다.");
  if (!Array.isArray(value.tags) || value.tags.length > 5) throw new Error("태그는 5개까지 넣을 수 있습니다.");
  return {
    category: value.category,
    title: validateCommunityText(value.title, "제목", 2, 120),
    body: validateCommunityText(value.body, "본문", 2, 20000),
    source: validateCommunityText(value.source ?? "", "출처", 0, 2000),
    original: validateCommunityText(value.original ?? "", "원문", 0, 20000),
    translation: validateCommunityText(value.translation ?? "", "번역문", 0, 20000),
    prompt: validateCommunityText(value.prompt ?? "", "프롬프트", 0, 30000),
    tags: [...new Set(value.tags.map(tag => validateCommunityText(tag, "태그", 1, 24)))],
    private: value.private,
  };
}

/** Comma-separated tag input, as on the website ("#표점, 시문"). */
export function parseCommunityTags(text: string): string[] {
  return [...new Set(text.split(/[,，]/).map(tag => tag.trim().replace(/^#/, "")).filter(Boolean))];
}
