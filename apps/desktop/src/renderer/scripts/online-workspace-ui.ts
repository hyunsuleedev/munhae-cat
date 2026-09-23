import { initOnlinePermissions } from "./online-permissions-ui";
import { createProjectSharing } from "./project-sharing-ui";
import type { MunhaeApi, OnlineWorkspaceStatus, ProjectSummary } from "../../shared/munhae-api";
import { t, ui } from "./i18n";

type WorkspaceApi = Pick<MunhaeApi["onlineProjects"], "status" | "sync">;
export type WorkspaceMonitorView = { status: OnlineWorkspaceStatus | null; error: string; busy: boolean };

export function projectLocationLabel(project: ProjectSummary): string {
  if (project.storageMode === "online") return ui`온라인 · ${project.title}`;
  return project.packagePath.replace(/^\/Users\/[^/]+/, "~");
}
export function projectDocumentKey(project: ProjectSummary): string {
  return `munhae.doc:${JSON.stringify([project.packagePath, project.projectId])}`;
}
export function onlineStatusLabel(status: OnlineWorkspaceStatus | null, error = ""): string {
  if (error) return t("온라인 상태 확인 실패");
  if (!status) return t("온라인 상태 확인 중…");
  if (status.role === "viewer" && status.state === "synced") return t("온라인 · 열람 전용");
  return t({ synced: "온라인 저장됨", pending: "온라인 전송 대기", syncing: "온라인에 저장 중…", error: "온라인 저장 실패", conflict: "온라인 변경 충돌", locked: "온라인 연결 필요" }[status.state]);
}

/** One status request at a time; a captured session never accepts another session's response. */
export class OnlineWorkspaceMonitor {
  view: WorkspaceMonitorView = { status: null, error: "", busy: false };
  private sessionId: string | null = null;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private queuedSync: Promise<void> | null = null;
  constructor(private api: WorkspaceApi, private projectId: string, private changed: (view: WorkspaceMonitorView) => void, private closed: () => void) {}
  private accept(status: OnlineWorkspaceStatus | null): void {
    if (!status) { this.closed(); return; }
    if (status.projectId !== this.projectId || (this.sessionId && status.sessionId !== this.sessionId)) { this.closed(); return; }
    this.sessionId = status.sessionId;
    this.view.status = status;
    this.view.error = "";
  }
  check(sync = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) {
      if (sync && !this.view.busy) {
        // A user retry must not disappear into the background status poll.
        // Coalesce repeated clicks into one sync after that poll settles.
        this.queuedSync ??= this.pending.then(() => this.check(true)).finally(() => { this.queuedSync = null; });
        return this.queuedSync;
      }
      return this.pending;
    }
    this.pending = this.runCheck(sync).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async runCheck(sync: boolean): Promise<void> {
    this.view.busy = sync;
    if (sync) this.changed(this.view);
    try {
      const result = await (sync ? this.api.sync() : this.api.status());
      if (this.disposed) return;
      if (!result.ok) throw new Error(result.error.message);
      this.accept(result.data);
    } catch (error) {
      if (!this.disposed) this.view.error = error instanceof Error ? error.message : t("온라인 상태를 확인하지 못했습니다.");
    } finally {
      if (!this.disposed) {
        this.view.busy = false;
        this.changed(this.view);
      }
    }
  }
  dispose(): void { this.disposed = true; }
}

export function initOnlineWorkspace(api: MunhaeApi, project: ProjectSummary): () => void {
  if (project.storageMode !== "online") return () => undefined;
  const statusbar = document.querySelector(".statusbar");
  if (!statusbar) return () => undefined;
  const sharing = createProjectSharing(api.onlineProjects);
  const permissions = initOnlinePermissions();
  const shareButton = document.createElement("button"); shareButton.type = "button"; shareButton.className = "btn btn-ghost btn-sm"; shareButton.textContent = t("공유"); shareButton.id = "btnShareOnlineProject";
  shareButton.addEventListener("click", () => void sharing.open(project.onlineProjectId, project.title));
  statusbar.prepend(shareButton);
  const control = document.createElement("button");
  control.type = "button"; control.id = "onlineWorkspaceStatus"; control.className = "online-workspace-status";
  control.setAttribute("aria-haspopup", "dialog");
  const label = document.createElement("span"); label.setAttribute("role", "status"); control.append(label);
  statusbar.querySelector(".sp")?.before(control);
  if (!control.isConnected) statusbar.prepend(control);
  const dialog = document.createElement("dialog");
  dialog.className = "online-workspace-dialog";
  dialog.setAttribute("aria-labelledby", "onlineWorkspaceHeading");
  dialog.innerHTML = '<header class="dl-h" id="onlineWorkspaceHeading"></header><div class="dl-b"><p class="online-workspace-message" role="status"></p><p class="online-workspace-time muted"></p><p class="online-workspace-action-result" role="status" hidden></p></div><footer class="dl-f"><button class="btn" type="button" data-export-recovery></button><button class="btn" type="button" data-server-version hidden></button><button class="btn" type="button" data-sync></button><button class="btn" type="button" data-close></button></footer>';
  dialog.querySelector("#onlineWorkspaceHeading")!.textContent = t("온라인 저장 상태");
  const detail = dialog.querySelector<HTMLElement>(".online-workspace-message")!;
  const time = dialog.querySelector<HTMLElement>(".online-workspace-time")!;
  const actionResult = dialog.querySelector<HTMLElement>(".online-workspace-action-result")!;
  const retry = dialog.querySelector<HTMLButtonElement>("[data-sync]")!;
  const recovery = dialog.querySelector<HTMLButtonElement>("[data-export-recovery]")!;
  const server = dialog.querySelector<HTMLButtonElement>("[data-server-version]")!;
  const close = dialog.querySelector<HTMLButtonElement>("[data-close]")!;
  retry.textContent = t("다시 연결"); recovery.textContent = t("복구본 내보내기"); server.textContent = t("서버 버전으로 열기"); close.textContent = t("닫기");
  document.body.append(dialog);
  const alert = document.createElement("div"); alert.className = "online-workspace-alert"; alert.hidden = true;
  alert.setAttribute("role", "alert");
  const alertText = document.createElement("span");
  const alertAction = document.createElement("button"); alertAction.className = "btn btn-sm"; alertAction.type = "button"; alertAction.textContent = t("상태 확인");
  alert.append(alertText, alertAction);
  const content = document.querySelector(".main .content");
  (content ?? statusbar).prepend(alert);
  let actionBusy = false;
  let disposed = false;
  const monitor = new OnlineWorkspaceMonitor(api.onlineProjects, project.onlineProjectId, view => {
    label.textContent = onlineStatusLabel(view.status, view.error);
    control.setAttribute("aria-label", ui`${label.textContent} · 온라인 저장 상태 보기`);
    control.dataset.state = view.error ? "error" : view.status?.state ?? "checking";
    const issue = !!view.error || !!view.status && ((!view.status.writable && view.status.role !== "viewer") || ["error", "conflict", "locked"].includes(view.status.state));
    control.classList.toggle("has-error", issue);
    control.title = view.error || view.status?.message || label.textContent;
    const explanation = view.error || view.status?.message || (view.status?.state === "synced" ? t("변경 내용이 온라인에 저장되어 있습니다.") : view.status?.dirty ? t("이 기기에 저장된 변경 내용을 온라인으로 전송하고 있습니다.") : label.textContent);
    detail.textContent = explanation;
    time.textContent = view.status?.updatedAt ? ui`마지막 온라인 저장 · ${new Date(view.status.updatedAt).toLocaleString()}` : "";
    retry.disabled = actionBusy || view.busy; retry.textContent = view.busy ? t("연결 중…") : t("다시 연결");
    recovery.disabled = actionBusy; server.disabled = actionBusy || view.busy;
    server.hidden = view.status?.state !== "conflict";
    alert.hidden = !issue;
    alertText.textContent = view.status && !view.status.writable ? ui`편집이 잠겨 있습니다. ${explanation}` : explanation;
    permissions.update(view.status);
    document.body.classList.toggle("online-workspace-readonly", !!view.status && !view.status.writable);
    document.dispatchEvent(new CustomEvent("munhae:online-workspace-status", { detail: view.status }));
  }, () => {
    if (disposed) return;
    document.body.dataset.authPending = "";
    dispose();
    location.replace("index.html");
  });
  const openStatus = () => { actionResult.hidden = true; if (!dialog.open) dialog.showModal(); };
  control.addEventListener("click", openStatus); alertAction.addEventListener("click", openStatus);
  close.addEventListener("click", () => dialog.close());
  retry.addEventListener("click", () => { if (!actionBusy) void monitor.check(true); });
  recovery.addEventListener("click", async () => {
    if (actionBusy) return;
    actionBusy = true; recovery.disabled = true;
    try {
      const result = await api.onlineProjects.exportRecovery(project.onlineProjectId);
      if (disposed) return;
      actionResult.textContent = !result.ok ? result.error.message : result.data ? ui`복구본을 저장했습니다 · ${result.data}` : "";
      actionResult.hidden = !actionResult.textContent;
    } catch (error) {
      actionResult.textContent = error instanceof Error ? error.message : t("복구본을 저장하지 못했습니다."); actionResult.hidden = false;
    } finally { actionBusy = false; recovery.disabled = false; }
  });
  server.addEventListener("click", async () => {
    if (actionBusy || !window.confirm(t("이 기기의 미저장·미전송 변경을 버리고 서버 버전으로 다시 여시겠습니까? 보관할 변경이 있다면 먼저 복구본을 내보내세요."))) return;
    actionBusy = true; server.disabled = true; retry.disabled = true;
    try {
      const result = await api.onlineProjects.open({ id: project.onlineProjectId, discardLocal: true });
      if (disposed) return;
      if (result.ok && result.data) location.href = "home.html";
      else if (!result.ok) { actionResult.textContent = result.error.message; actionResult.hidden = false; }
    } catch (error) { actionResult.textContent = error instanceof Error ? error.message : t("프로젝트를 열지 못했습니다."); actionResult.hidden = false; }
    finally { actionBusy = false; server.disabled = false; retry.disabled = false; }
  });
  label.textContent = onlineStatusLabel(null);
  control.setAttribute("aria-label", ui`${label.textContent} · 온라인 저장 상태 보기`);
  void monitor.check();
  let timer = window.setInterval(() => void monitor.check(), 2000);
  const hide = (event: PageTransitionEvent) => {
    window.clearInterval(timer);
    if (!event.persisted) dispose();
  };
  const show = (event: PageTransitionEvent) => {
    if (event.persisted && !disposed) {
      // A BFCache page can belong to a session that has since closed or changed.
      // Keep its old document hidden until session verification and a fresh load.
      document.body.dataset.authPending = "";
      void monitor.check().then(() => { if (!disposed) location.reload(); });
    }
  };
  const dispose = () => { disposed = true; monitor.dispose(); permissions.dispose(); sharing.dispose(); shareButton.remove(); control.remove(); dialog.remove(); alert.remove(); window.clearInterval(timer); window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", show);
  return dispose;
}
