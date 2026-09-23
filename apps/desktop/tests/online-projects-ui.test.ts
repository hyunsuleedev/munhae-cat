import { describe, expect, it, vi } from "vitest";
import type { IpcResult, OnlineProject, ProjectSummary } from "../src/shared/munhae-api";
import { OnlineProjectsController } from "../src/renderer/scripts/online-projects-ui";

const project = (id = "project-a", ownerId = "account-a"): OnlineProject => ({
  id, title: "관서악부 연구", description: "공동 연구", ownerId, storageMode: "online", role: "owner",
  createdAt: "2026-09-22T10:00:00Z", updatedAt: "2026-09-22T10:00:00Z",
});
const success = <T>(data: T): IpcResult<T> => ({ ok: true, data });
const failure = { ok: false, error: { code: "offline", message: "연결을 확인하세요." } } as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const api = {
    list: vi.fn(async (): Promise<IpcResult<OnlineProject[]>> => success([])),
    create: vi.fn(async (_input: { title: string; description?: string; requestId: string }): Promise<IpcResult<OnlineProject>> => success(project())),
    get: vi.fn(async (_id: string): Promise<IpcResult<OnlineProject>> => success(project())),
    open: vi.fn(async (_input: { id: string; discardLocal?: boolean }): Promise<IpcResult<ProjectSummary | null>> => success({ projectId: "project-a", title: "관서악부 연구", packagePath: "online://account-a/project-a", storageMode: "online", onlineProjectId: "project-a", accountId: "account-a", openedAt: "2026-09-22T10:00:00Z" })),
    exportRecovery: vi.fn(async (_id: string): Promise<IpcResult<string | null>> => success("/tmp/복구본.munhaepkg")),
  };
  let serial = 0;
  const changed = vi.fn();
  const controller = new OnlineProjectsController(api, changed, () => `request-${++serial}`);
  controller.setAccount("account-a");
  return { api, controller, changed };
}

describe("online project creation", () => {
  it("reuses the same request ID after an ambiguous failure and changes it when the form changes", async () => {
    const { api, controller } = setup();
    api.create.mockResolvedValueOnce(failure).mockResolvedValueOnce(failure);
    const fields = { title: " 관서악부 연구 ", description: "공동 연구" };
    expect(await controller.create(fields)).toBeNull();
    expect(controller.state.createError).toBe("연결을 확인하세요.");
    expect(await controller.create(fields)).toBeNull();
    expect(api.create.mock.calls[0]?.[0]).toEqual(api.create.mock.calls[1]?.[0]);
    await controller.create({ ...fields, title: "훈민정음 연구" });
    expect(api.create.mock.calls[2]?.[0].requestId).not.toBe(api.create.mock.calls[0]?.[0].requestId);
    expect(controller.state.projects).toEqual([project()]);
    expect(controller.state.createError).toBe("");
  });

  it("blocks duplicate submissions and prevents a stale list from erasing a created project", async () => {
    const { api, controller } = setup();
    const list = deferred<IpcResult<OnlineProject[]>>();
    const create = deferred<IpcResult<OnlineProject>>();
    api.list.mockReturnValueOnce(list.promise);
    api.create.mockReturnValueOnce(create.promise);
    const loading = controller.refresh();
    const submission = controller.create({ title: "관서악부 연구", description: "" });
    expect(controller.state.submitting).toBe(true);
    expect(await controller.create({ title: "관서악부 연구", description: "" })).toBeNull();
    expect(api.create).toHaveBeenCalledTimes(1);
    create.resolve(success(project()));
    await submission;
    list.resolve(success([]));
    await loading;
    expect(controller.state.projects).toEqual([project()]);
    expect(controller.state.loading).toBe(false);
    expect(controller.state.submitting).toBe(false);
  });

  it("validates the form without starting a request", async () => {
    const { api, controller } = setup();
    for (const fields of [{ title: "  ", description: "" }, { title: "文".repeat(161), description: "" }, { title: "문해", description: "文".repeat(4001) }]) {
      expect(await controller.create(fields)).toBeNull();
      expect(controller.state.createError).toBeTruthy();
    }
    expect(api.create).not.toHaveBeenCalled();
  });
});

describe("account-scoped online projects", () => {
  it("clears account data immediately and ignores late list, detail and creation responses", async () => {
    const { api, controller } = setup();
    await controller.create({ title: "관서악부 연구", description: "" });
    const list = deferred<IpcResult<OnlineProject[]>>();
    const detail = deferred<IpcResult<OnlineProject>>();
    const create = deferred<IpcResult<OnlineProject>>();
    api.list.mockReturnValueOnce(list.promise);
    api.get.mockReturnValueOnce(detail.promise);
    api.create.mockReturnValueOnce(create.promise);
    const loading = controller.refresh();
    const opening = controller.open("project-a");
    const creating = controller.create({ title: "다른 연구", description: "" });
    controller.setAccount("account-b");
    expect(controller.state.projects).toEqual([]);
    expect(controller.state.project).toBeNull();
    expect(controller.state.selectedId).toBeNull();
    list.resolve(success([project()]));
    detail.resolve(success(project()));
    create.resolve(success(project("other")));
    await Promise.all([loading, opening, creating]);
    expect(controller.state.accountId).toBe("account-b");
    expect(controller.state.projects).toEqual([]);
    expect(controller.state.project).toBeNull();
    expect(controller.state.createError).toBe("");
    controller.setAccount(null);
    await controller.refresh();
    await controller.open("project-a");
    expect(await controller.create({ title: "문해", description: "" })).toBeNull();
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledTimes(2);
  });

  it("reads details from the server and ignores a previous selection's late response", async () => {
    const { api, controller } = setup();
    const first = deferred<IpcResult<OnlineProject>>();
    api.get.mockReturnValueOnce(first.promise).mockResolvedValueOnce(success(project("project-b")));
    const opening = controller.open("project-a");
    await controller.open("project-b");
    first.resolve(success(project("project-a")));
    await opening;
    expect(controller.state.project?.id).toBe("project-b");
    expect(api.get.mock.calls).toEqual([["project-a"], ["project-b"]]);
    controller.closeDetails();
    expect(controller.state.project).toBeNull();
  });

  it("keeps list and detail errors retryable", async () => {
    const { api, controller } = setup();
    api.list.mockResolvedValueOnce(failure).mockResolvedValueOnce(success([project()]));
    await controller.refresh();
    expect(controller.state.listError).toBe("연결을 확인하세요.");
    await controller.refresh();
    expect(controller.state.listError).toBe("");
    expect(controller.state.projects).toHaveLength(1);
    api.get.mockRejectedValueOnce(new Error("연결 끊김"));
    await controller.open("project-a");
    expect(controller.state.detailError).toBe("연결 끊김");
    await controller.open("project-a");
    expect(controller.state.detailError).toBe("");
    expect(controller.state.project?.id).toBe("project-a");
  });
});


describe("opening an online workspace", () => {
  it("does not navigate on a conflict and exports recovery before an explicit server-version open", async () => {
    const { api, controller } = setup();
    api.open.mockResolvedValueOnce({ ok: false, error: { code: "online_workspace_conflict", message: "서버에서 변경되었습니다." } });
    expect(await controller.openWorkspace("project-a")).toBeNull();
    expect(controller.state.openErrorCode).toBe("online_workspace_conflict");
    await controller.exportRecovery();
    expect(api.exportRecovery).toHaveBeenCalledExactlyOnceWith("project-a");
    expect(controller.state.recoveryMessage).toContain("복구본.munhaepkg");
    expect(api.open).toHaveBeenCalledTimes(1);
    const opened = await controller.openWorkspace("project-a", true);
    expect(opened?.storageMode).toBe("online");
    expect(api.open.mock.calls[1]?.[0]).toEqual({ id: "project-a", discardLocal: true });
  });
  it("blocks duplicate opens and ignores an old account's successful open", async () => {
    const { api, controller } = setup();
    const response = deferred<IpcResult<ProjectSummary | null>>();
    api.open.mockReturnValueOnce(response.promise);
    const pending = controller.openWorkspace("project-a");
    expect(await controller.openWorkspace("project-b")).toBeNull();
    expect(api.open).toHaveBeenCalledTimes(1);
    controller.setAccount("account-b");
    response.resolve(success({ projectId: "project-a", title: "관서악부 연구", packagePath: "online://account-a/project-a", storageMode: "online", onlineProjectId: "project-a", accountId: "account-a", openedAt: "2026-09-22T10:00:00Z" }));
    expect(await pending).toBeNull();
    expect(controller.state.openId).toBeNull();
    expect(controller.state.openError).toBe("");
  });
});
