import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { OnlinePostgresRemote, assetHash, emptyOnlineRows } from "../src/main/online-postgres-remote";
import type { OnlineRowChange } from "@munhae/db-sqlite";

const owner = "00000000-0000-4000-8000-000000000001";
const project = "00000000-0000-4000-8000-000000000002";
const internal = "00000000-0000-4000-8000-000000000003";
const mutation = "00000000-0000-4000-8000-000000000004";
const updated = "2026-09-22T12:00:00Z";
const initial = () => ({ project_id: project, data_project_id: null, revision: 0, schema_version: 10, updated_at: updated, tables: emptyOnlineRows() });
const initialized = () => {
  const tables = emptyOnlineRows();
  tables.core_projects = [{ id: internal, title: "원문", slug: null, description: null, default_target_locale: "ko", status: "active", created_by_actor_id: "actor", created_at: updated, updated_at: updated, archived_at: null }];
  return { ...initial(), revision: 1, data_project_id: internal, tables };
};
type Reply = { body: unknown; status?: number; binary?: boolean };
function fixture(replies: Reply[]) {
  const fetcher = vi.fn(async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) => {
    const next = replies.shift(); if (!next) throw new Error("Unexpected HTTP call");
    return new Response(next.binary ? next.body as Uint8Array<ArrayBuffer> : JSON.stringify(next.body), {
      status: next.status ?? 200, headers: { "content-type": next.binary ? "application/octet-stream" : "application/json" },
    });
  });
  const client = createClient("https://project.supabase.co", "publishable-test", { accessToken: async () => "test-jwt", db: { retry: false }, global: { fetch: fetcher } });
  return { remote: new OnlinePostgresRemote(action => action(client, owner)), fetcher };
}

describe("canonical PostgreSQL row transport", () => {
  it("reads a complete consistent 48-table snapshot using the guarded project RPC", async () => {
    const data = initialized(), f = fixture([{ body: data }]);
    expect(await f.remote.get(project)).toEqual({ projectId: project, dataProjectId: internal, revision: 1, updatedAt: updated, tables: data.tables });
    const [url, input] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toContain("/rest/v1/rpc/get_online_project_data");
    expect(JSON.parse(input!.body as string)).toEqual({ p_project_id: project });
    expect(new Headers(input!.headers).get("authorization")).toBe("Bearer test-jwt");
    expect(await fixture([{ body: initial() }]).remote.get(project)).toMatchObject({ revision: 0, dataProjectId: null });
  });

  it.each([
    { ...initial(), project_id: internal }, { ...initial(), schema_version: 11 }, { ...initial(), revision: -1 },
    { ...initial(), updated_at: null }, { ...initial(), data_project_id: internal },
    { ...initialized(), data_project_id: "wrong-internal-project" },
    { ...initial(), tables: {} }, { ...initial(), tables: { ...emptyOnlineRows(), chat_agent_sessions: [] } },
  ])("rejects a mismatched project/schema/identity or incomplete table response", async data => {
    await expect(fixture([{ body: data }]).remote.get(project)).rejects.toMatchObject({ code: "online_workspace_response_invalid" });
  });

  it("commits only row deltas with a revision and stable mutation receipt", async () => {
    const f = fixture([{ body: { revision: 2, updated_at: updated } }, { body: { revision: 2, updated_at: updated } }]);
    const row = initialized().tables.core_projects![0]!;
    const changes: OnlineRowChange[] = [{ table: "core_projects", key: { id: internal }, before: row, after: { ...row, title: "변경" } }];
    expect(await f.remote.commit(project, 1, mutation, changes)).toEqual({ revision: 2, updatedAt: updated });
    expect(await f.remote.commit(project, 1, mutation, changes)).toEqual({ revision: 2, updatedAt: updated });
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toEqual({ p_project_id: project, p_expected_revision: 1, p_mutation_id: mutation, p_schema_version: 10, p_changes: changes });
    await expect(fixture([{ body: { revision: 3, updated_at: updated } }]).remote.commit(project, 1, mutation, changes)).rejects.toMatchObject({ code: "online_workspace_response_invalid" });
  });

  it("supplies fenced legacy migration credentials only for the explicit initial conversion", async () => {
    const f = fixture([{ body: { revision: 1, updated_at: updated } }, { status: 400, body: { code: "P0001", message: "ONLINE_DATA_LEGACY_LEASE_LOST" } }]);
    await f.remote.commit(project, 0, mutation, [], { leaseId: mutation, fence: 3 });
    expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ p_legacy_lease_id: mutation, p_legacy_fence: 3 });
    await expect(f.remote.commit(project, 0, mutation, [], { leaseId: mutation, fence: 3 })).rejects.toMatchObject({ code: "online_workspace_lease_lost" });
    expect(() => f.remote.commit(project, 0, mutation, [], { leaseId: mutation, fence: 0 })).toThrow();
  });

  it.each([
    ["40001", "online_workspace_conflict"], ["42501", "online_workspace_forbidden"],
    ["PGRST301", "session_not_found"], ["PGRST202", "online_workspace_unavailable"], ["23503", "online_workspace_invalid_data"],
  ])("maps %s without leaking the raw database diagnostic", async (code, expected) => {
    const f = fixture([{ status: 400, body: { code, message: "private database diagnostic" } }]);
    await expect(f.remote.get(project)).rejects.toMatchObject({ code: expected });
    const denied = new OnlinePostgresRemote(async () => { throw new Error("PRIVATE_TOKEN_VALUE"); });
    await expect(denied.get(project)).rejects.not.toHaveProperty("message", expect.stringContaining("PRIVATE_TOKEN_VALUE"));
  });

  it("validates reconnect cursors and rejects invalid ids before making a request", async () => {
    const f = fixture([{ body: { revision: 3, updated_at: updated, commits: [] } }, { body: { revision: 3, updated_at: updated, commits: [] } }, { body: { revision: 2, updated_at: updated, commits: [] } }]);
    expect(await f.remote.changes(project, 2)).toBe(true); expect(await f.remote.changes(project, 3)).toBe(false);
    await expect(f.remote.changes(project, 3)).rejects.toMatchObject({ code: "online_workspace_response_invalid" });
    await expect(f.remote.changes(project, -1)).rejects.toMatchObject({ code: "online_workspace_response_invalid" });
    expect(() => f.remote.get("project,or.owner.eq.any")).toThrow();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("uploads an immutable copy of an individual asset under this account/project/hash", async () => {
    const bytes = new Uint8Array([1, 2, 3]), expected = assetHash(bytes);
    const f = fixture([{ body: { Key: `online-project-assets/${owner}/${project}/${expected}` } }]);
    const upload = f.remote.uploadAsset(project, bytes); bytes[0] = 9;
    expect(await upload).toBe(expected);
    const [url, input] = f.fetcher.mock.calls[0]!;
    expect(String(url)).toContain(`/storage/v1/object/online-project-assets/${owner}/${project}/${expected}`);
    expect(new Uint8Array(input!.body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Headers(input!.headers).get("x-upsert")).toBe("false");
  });

  it("verifies duplicate assets and downloads by digest before allowing local use", async () => {
    const bytes = new Uint8Array([1, 2, 3]), sha = assetHash(bytes);
    const f = fixture([{ status: 409, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } }, { binary: true, body: bytes }, { binary: true, body: bytes }, { binary: true, body: new Uint8Array([1, 2, 4]) }]);
    expect(await f.remote.uploadAsset(project, bytes)).toBe(sha);
    expect(await f.remote.downloadAsset(project, sha)).toEqual(bytes);
    await expect(f.remote.downloadAsset(project, sha)).rejects.toMatchObject({ code: "online_workspace_response_invalid" });
    expect(() => f.remote.downloadAsset(project, "../another-owner")).toThrow();
  });
});
