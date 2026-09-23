import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { createOnlineProjectInput, OnlineProjectsService } from "../src/main/online-projects";

const owner = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";
const row = (id = projectId) => ({ id, owner_id: owner, title: "관서악부", description: "공동 연구",
  created_at: "2026-09-22T10:00:00+00:00", updated_at: "2026-09-22T10:00:00+00:00", request_id: requestId });
function setup(replies: unknown[]) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(replies.shift()), { status: 200, headers: { "content-type": "application/json" } }));
  const client = createClient("https://project.supabase.co", "publishable-test-key", {
    accessToken: async () => "test-jwt", global: { fetch: fetcher },
  });
  return { service: new OnlineProjectsService(action => action(client, owner)), fetcher };
}

describe("online project service", () => {
  it("normalizes input and rejects owner/path injection and invalid fields before a request", () => {
    expect(createOnlineProjectInput({ title: "  관서악부  ", requestId })).toEqual({ title: "관서악부", description: "", requestId });
    for (const input of [null, { title: " ", requestId }, { title: "줄\n바꿈", requestId },
      { title: "x", requestId, ownerId: owner }, { title: "x", requestId, packagePath: "/tmp/a" },
      { title: "x", requestId: "id.eq.any" }, { title: "x", requestId, description: 2 },
      { title: "字".repeat(161), requestId }, { title: "x", requestId, description: "x".repeat(4001) }]) {
      expect(() => createOnlineProjectInput(input)).toThrow();
    }
  });

  it("creates through the authenticated RPC and returns only the public project model", async () => {
    const { service, fetcher } = setup([row()]);
    const project = await service.create({ title: " 관서악부 ", description: " 공동 연구 ", requestId });
    expect(project).toMatchObject({ id: projectId, ownerId: owner, title: "관서악부", storageMode: "online", role: "owner" });
    expect(project).not.toHaveProperty("request_id");
    expect(project).not.toHaveProperty("packagePath");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/rest/v1/rpc/create_online_project");
    expect(JSON.parse(init.body as string)).toEqual({ p_title: "관서악부", p_description: "공동 연구", p_request_id: requestId });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-jwt");
  });

  it("rejects a response belonging to a different account", async () => {
    const { service } = setup([{ ...row(), owner_id: requestId }]);
    await expect(service.create({ title: "x", requestId })).rejects.toMatchObject({ code: "online_project_response_invalid" });
  });

  it("treats absent or inaccessible ids alike and checks access through the membership RPC", async () => {
    const { service, fetcher } = setup([[]]);
    await expect(service.get(projectId)).rejects.toMatchObject({ code: "not_found" });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/rest/v1/rpc/get_online_project_access");
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ p_project_id: projectId });
  });

  it("fetches beyond the first page with a stable time/id cursor", async () => {
    const page = Array.from({ length: 200 }, (_, index) => row(`00000000-0000-4000-8000-${String(1000 - index).padStart(12, "0")}`));
    const { service, fetcher } = setup([page, [row()]]);
    expect(await service.list()).toHaveLength(201);
    const next = new URL(String(fetcher.mock.calls[1][0]));
    expect(next.pathname).toBe("/rest/v1/rpc/list_online_projects");
    expect(JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ p_before_time: page.at(-1)!.created_at, p_before_id: page.at(-1)!.id });
  });

  it("keeps the authenticated account separate from a shared project's owner", async () => {
    const { service } = setup([{ ...row(), owner_id: requestId, role: "viewer" }]);
    expect(await service.get(projectId)).toMatchObject({ ownerId: requestId, accountId: owner, role: "viewer" });
  });
  it("rejects owner-role injection in collaboration inputs", () => {
    const { service, fetcher } = setup([]);
    expect(() => service.invite({ projectId, email: "member@example.com", role: "owner" })).toThrow();
    expect(() => service.updateMember({ projectId, userId: requestId, role: "owner" })).toThrow();
    expect(() => service.respond({ invitationId: requestId, accept: "true" })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not start an API call when authorization rejects", async () => {
    const service = new OnlineProjectsService(async () => { throw new Error("signed out"); });
    await expect(service.list()).rejects.toThrow("signed out");
  });
});
