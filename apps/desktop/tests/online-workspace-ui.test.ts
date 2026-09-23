import { describe, expect, it, vi } from "vitest";
import type { IpcResult, OnlineWorkspaceStatus, ProjectSummary } from "../src/shared/munhae-api";
import { OnlineWorkspaceMonitor, onlineStatusLabel, projectDocumentKey, projectLocationLabel } from "../src/renderer/scripts/online-workspace-ui";
const status = (extra: Partial<OnlineWorkspaceStatus> = {}): OnlineWorkspaceStatus => ({ projectId: "remote", sessionId: "session", state: "synced", revision: 3, dirty: false, writable: true, message: null, updatedAt: "2026-09-22T12:00:00Z", ...extra });
const ok = (data: OnlineWorkspaceStatus | null): IpcResult<OnlineWorkspaceStatus | null> => ({ ok: true, data });
function setup() {
  const api = { status: vi.fn(async () => ok(status())), sync: vi.fn(async () => ok(status())) };
  const changed = vi.fn(), closed = vi.fn();
  return { api, changed, closed, monitor: new OnlineWorkspaceMonitor(api, "remote", changed, closed) };
}
describe("online workspace status", () => {
  it("accepts only the opened project and its captured session", async () => {
    const { api, monitor, closed } = setup();
    api.status.mockResolvedValueOnce(ok(status({ projectId: "other" })));
    await monitor.check();
    expect(monitor.view.status).toBeNull();
    expect(closed).toHaveBeenCalledTimes(1);
    await monitor.check();
    expect(monitor.view.status?.sessionId).toBe("session");
    api.status.mockResolvedValueOnce(ok(status({ sessionId: "new", state: "conflict" })));
    await monitor.check();
    expect(monitor.view.status?.state).toBe("synced");
    expect(closed).toHaveBeenCalledTimes(2);
  });
  it("keeps a failed request actionable and refreshes through explicit sync", async () => {
    const { api, monitor } = setup();
    api.status.mockRejectedValueOnce(new Error("연결 실패"));
    await monitor.check();
    expect(monitor.view.error).toBe("연결 실패");
    api.sync.mockResolvedValueOnce(ok(status({ state: "pending", dirty: true })));
    await monitor.check(true);
    expect(api.sync).toHaveBeenCalledOnce();
    expect(monitor.view.error).toBe("");
    expect(onlineStatusLabel(monitor.view.status)).toBe("온라인 전송 대기");
    expect(onlineStatusLabel(status({ state: "conflict", writable: false }))).toBe("온라인 변경 충돌");
  });
  it("does not overlap polls and ignores late responses after disposal", async () => {
    const { api, monitor, changed } = setup();
    let resolve!: (value: IpcResult<OnlineWorkspaceStatus | null>) => void;
    api.status.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const pending = monitor.check();
    const overlapping = monitor.check();
    expect(api.status).toHaveBeenCalledOnce();
    monitor.dispose();
    resolve(ok(status()));
    await Promise.all([pending, overlapping]);
    expect(changed).not.toHaveBeenCalled();
    expect(monitor.view.status).toBeNull();
  });
  it("runs one explicit retry after an in-flight status poll instead of dropping or duplicating it", async () => {
    const { api, monitor } = setup();
    let resolve!: (value: IpcResult<OnlineWorkspaceStatus | null>) => void;
    api.status.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const polling = monitor.check();
    const retry = monitor.check(true);
    const repeatedRetry = monitor.check(true);
    expect(api.sync).not.toHaveBeenCalled();
    resolve(ok(status({ state: "error", dirty: true, message: "전송 실패" })));
    await Promise.all([polling, retry, repeatedRetry]);
    expect(api.status).toHaveBeenCalledOnce();
    expect(api.sync).toHaveBeenCalledOnce();
    expect(monitor.view.status?.state).toBe("synced");
  });
  it("does not execute a queued retry after the page has been disposed", async () => {
    const { api, monitor } = setup();
    let resolve!: (value: IpcResult<OnlineWorkspaceStatus | null>) => void;
    api.status.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const polling = monitor.check();
    const retry = monitor.check(true);
    monitor.dispose();
    resolve(ok(status()));
    await Promise.all([polling, retry]);
    expect(api.sync).not.toHaveBeenCalled();
  });
  it("closes the UI when its active session no longer exists", async () => {
    const { api, monitor, closed } = setup();
    api.status.mockResolvedValueOnce(ok(null));
    await monitor.check();
    expect(closed).toHaveBeenCalledOnce();
  });
  it("shows an online label without exposing identifiers and scopes last documents by account", () => {
    const online: ProjectSummary = { projectId: "db", title: "관서악부", storageMode: "online", onlineProjectId: "remote", accountId: "a", packagePath: "online://a/remote", openedAt: "now" };
    expect(projectLocationLabel(online)).toBe("온라인 · 관서악부");
    expect(projectDocumentKey(online)).not.toBe(projectDocumentKey({ ...online, accountId: "b", packagePath: "online://b/remote" }));
    expect(projectLocationLabel({ projectId: "local", title: "로컬", storageMode: "local", packagePath: "/Users/reader/research.munhae", openedAt: "now" })).toBe("~/research.munhae");
  });
});
