import { describe, expect, it, vi } from "vitest";
import { ProjectChangeCoordinator, type ProjectChange, type ProjectChangeState } from "../src/renderer/scripts/project-change-ui";

const event = (extra: Partial<ProjectChange> = {}): ProjectChange => ({ projectId: "internal-project", accountId: "account", sessionId: "session", revision: 1, reason: "commit", documentIds: ["doc"], scopes: ["translation"], ...extra });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  let blocked = false, version = 1, state: ProjectChangeState = { pending: false, busy: false, error: "" };
  const apply = vi.fn();
  const prepare = vi.fn(async (_change: ProjectChange): Promise<() => void> => apply);
  const coordinator = new ProjectChangeCoordinator({ projectId: "internal-project", accountId: "account" }, next => { state = next; });
  coordinator.register({ blocked: () => blocked, version: () => version, prepare });
  return { coordinator, prepare, apply, state: () => state, block: (next: boolean) => { blocked = next; }, advance: () => { version += 1; } };
}

describe("saved project changes", () => {
  it("waits for the workspace session and rejects other project/account/session events", async () => {
    const s = setup();
    s.coordinator.receive(event());
    await s.coordinator.flush();
    expect(s.prepare).not.toHaveBeenCalled();
    s.coordinator.establishSession("session");
    await s.coordinator.flush();
    expect(s.apply).toHaveBeenCalledOnce();
    for (const extra of [{ projectId: "other" }, { accountId: "other" }, { sessionId: "other" }]) s.coordinator.receive(event({ revision: 2, ...extra }));
    await s.coordinator.flush();
    expect(s.apply).toHaveBeenCalledOnce();
  });
  it("preserves an unsaved draft and an ongoing AI job until their guard clears", async () => {
    const s = setup(); s.coordinator.establishSession("session"); s.block(true);
    s.coordinator.receive(event());
    await s.coordinator.flush(true);
    expect(s.state().pending).toBe(true); expect(s.prepare).not.toHaveBeenCalled();
    s.block(false); await s.coordinator.flush();
    expect(s.apply).toHaveBeenCalledOnce(); expect(s.state().pending).toBe(false);
  });
  it("does not replace a draft started while remote data was being fetched", async () => {
    const s = setup(); s.coordinator.establishSession("session");
    const request = deferred<() => void>(); s.prepare.mockReturnValueOnce(request.promise);
    s.coordinator.receive(event()); const pending = s.coordinator.flush();
    s.block(true); request.resolve(s.apply); await pending;
    expect(s.apply).not.toHaveBeenCalled(); expect(s.state().pending).toBe(true);
    s.block(false); await s.coordinator.flush();
    expect(s.prepare).toHaveBeenCalledTimes(2); expect(s.apply).toHaveBeenCalledOnce();
  });
  it("drops a response overtaken by a local save or document navigation", async () => {
    const s = setup(); s.coordinator.establishSession("session");
    const request = deferred<() => void>(); s.prepare.mockReturnValueOnce(request.promise);
    s.coordinator.receive(event()); const pending = s.coordinator.flush();
    s.advance(); request.resolve(s.apply); await pending;
    expect(s.apply).not.toHaveBeenCalled(); expect(s.state().pending).toBe(true);
    await s.coordinator.flush(); expect(s.apply).toHaveBeenCalledOnce();
  });
  it("coalesces changes during a fetch and applies only the newest combined read", async () => {
    const s = setup(); s.coordinator.establishSession("session"); s.coordinator.receive(event()); await s.coordinator.flush(); s.apply.mockClear();
    const request = deferred<() => void>(); s.prepare.mockReturnValueOnce(request.promise);
    s.coordinator.receive(event({ revision: 2 })); const pending = s.coordinator.flush();
    s.coordinator.receive(event({ revision: 3, documentIds: ["other-doc"], scopes: ["materials"] }));
    request.resolve(s.apply); await pending;
    expect(s.apply).not.toHaveBeenCalled();
    await s.coordinator.flush();
    expect(s.prepare.mock.lastCall?.[0]).toMatchObject({ revision: 3, reason: "resync", scopes: ["translation", "materials"] });
    expect(s.apply).toHaveBeenCalledOnce();
    s.coordinator.receive(event({ revision: 2 })); await s.coordinator.flush(); expect(s.apply).toHaveBeenCalledOnce();
  });
  it("refreshes all scopes on a revision gap and accepts same-revision reconnect invalidation", async () => {
    const s = setup(); s.coordinator.establishSession("session");
    s.coordinator.receive(event()); await s.coordinator.flush();
    s.coordinator.receive(event({ revision: 8, documentIds: ["other"] })); await s.coordinator.flush();
    expect(s.prepare.mock.lastCall?.[0]).toMatchObject({ reason: "resync", documentIds: [] });
    s.coordinator.receive(event({ revision: 8, reason: "resync" })); await s.coordinator.flush();
    expect(s.apply).toHaveBeenCalledTimes(3);
  });
  it("keeps failure pending without retry loops, then recovers through explicit retry", async () => {
    const s = setup(); s.coordinator.establishSession("session");
    s.prepare.mockRejectedValueOnce(new Error("연결 실패")); s.coordinator.receive(event()); await s.coordinator.flush();
    expect(s.state()).toMatchObject({ pending: true, error: "연결 실패" }); expect(s.apply).not.toHaveBeenCalled();
    await s.coordinator.flush(); expect(s.prepare).toHaveBeenCalledOnce();
    await s.coordinator.flush(true); expect(s.apply).toHaveBeenCalledOnce(); expect(s.state()).toMatchObject({ pending: false, error: "" });
  });
  it("never applies an in-flight response after account/session disposal", async () => {
    const s = setup(); s.coordinator.establishSession("session");
    const request = deferred<() => void>(); s.prepare.mockReturnValueOnce(request.promise);
    s.coordinator.receive(event()); const pending = s.coordinator.flush();
    s.coordinator.establishSession("new-session"); request.resolve(s.apply); await pending;
    expect(s.apply).not.toHaveBeenCalled();
  });
  it("defers a deleted-document navigation while drafts exist", async () => {
    const s = setup(); s.coordinator.establishSession("session");
    const navigateHome = vi.fn(); s.prepare.mockResolvedValue(navigateHome); s.block(true);
    s.coordinator.receive(event({ scopes: ["documents"] })); await s.coordinator.flush(); expect(navigateHome).not.toHaveBeenCalled();
    s.block(false); await s.coordinator.flush(); expect(navigateHome).toHaveBeenCalledOnce();
  });
});
