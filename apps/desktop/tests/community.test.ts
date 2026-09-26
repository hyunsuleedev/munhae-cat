import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/main/auth", () => ({ withAuthenticatedClient: vi.fn() }));
import { CommunityService, dispatchCommunity } from "../src/main/community";
import { IPC_CHANNELS } from "../src/shared/munhae-api";
import { parseCommunityTags, validateCommunityPost, type CommunityPostInput } from "../src/shared/community";

const input: CommunityPostInput = {
  category: "question", title: "  國之語音 해석  ", body: "나라의 말소리가 무엇을 가리키나요?", source: "", original: "", translation: "",
  prompt: "", tags: ["훈민정음", "훈민정음"], private: true,
};

/** A PostgREST query is awaitable at any point of its builder chain. */
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "order", "eq", "insert", "update", "delete", "single", "maybeSingle", "upsert"]) chain[name] = () => chain;
  chain.then = (resolve: (value: unknown) => void) => resolve(result);
  return chain;
}

describe("community posts", () => {
  it("applies the website's rules before anything reaches the server", () => {
    expect(validateCommunityPost(input)).toMatchObject({ title: "國之語音 해석", tags: ["훈민정음"], private: true });
    expect(() => validateCommunityPost({ ...input, category: "discussion" })).toThrow("비공개 글은 질문·문의에서만");
    expect(() => validateCommunityPost({ ...input, tags: ["a", "b", "c", "d", "e", "f"] })).toThrow("태그는 5개까지");
    expect(() => validateCommunityPost({ ...input, title: "a" })).toThrow("제목");
    expect(parseCommunityTags("#표점, 시문，표점,  ")).toEqual(["표점", "시문"]);
  });

  it("reads the feed as the signed-in member with author names and comment counts", async () => {
    const tables: Record<string, unknown> = {
      community_posts: query({ data: [{ id: "p1", category: "resource", title: "프롬프트", body: "사용 예시", tags: ["표점", 3], is_private: false, author_id: "u1",
        community_profiles: { display_name: "홍길동" }, community_comments: [{ count: 2 }], created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z", resolved: false }], error: null }),
      community_bookmarks: query({ data: [{ post_id: "p1" }], error: null }),
    };
    const client = {
      rpc: async (name: string) => ({ data: name === "community_ensure_profile" ? "Hyunsu" : true, error: null }),
      from: (table: string) => tables[table],
    } as unknown as SupabaseClient;
    const service = new CommunityService(async action => action(client, "u1") as never);
    const feed = await service.feed();
    expect(feed.member).toEqual({ id: "u1", name: "Hyunsu", isModerator: true });
    expect(feed.bookmarks).toEqual(["p1"]);
    expect(feed.posts[0]).toMatchObject({ authorName: "홍길동", commentCount: 2, tags: ["표점"], category: "resource", private: false });
  });

  it("explains database rejections in the same words as the website", async () => {
    const client = { from: () => query({ data: null, error: { code: "42501" } }) } as unknown as SupabaseClient;
    const service = new CommunityService(async action => action(client, "u1") as never);
    await expect(service.deletePost("p1")).rejects.toThrow("이 작업을 할 권한이 없습니다");
  });

  it("rejects malformed identifiers and inputs at the IPC boundary", () => {
    expect(() => dispatchCommunity(IPC_CHANNELS.communityThread, ["../posts"])).toThrow("식별자");
    expect(() => dispatchCommunity(IPC_CHANNELS.communityResolvePost, ["0f8fad5b-d9cb-469f-a165-70867728950e", "yes"])).toThrow("요청 값");
    expect(() => dispatchCommunity(IPC_CHANNELS.communityAddComment, ["0f8fad5b-d9cb-469f-a165-70867728950e", "   "])).toThrow("댓글");
  });
});
