import type { MunhaeApi, ProjectSummary, ProjectChangeEvent } from "../../shared/munhae-api";
import { t } from "./i18n";

/** Invalidations describe committed changes; document contents still cross typed IPC. */
export type ProjectChange = ProjectChangeEvent;
export type ProjectRefresh = {
  blocked(): boolean;
  /** Changes when the page navigates or a local save/edit supersedes an in-flight read. */
  version(): unknown;
  prepare(change: ProjectChange): Promise<() => void>;
};
export type ProjectChangeState = { pending: boolean; busy: boolean; error: string };

export class ProjectChangeCoordinator {
  private sessionId: string | null = null;
  private early: ProjectChange[] = [];
  private pending: ProjectChange | null = null;
  private applied = -1;
  private generation = 0;
  private disposed = false;
  private busy = false;
  private error = "";
  private refresh: ProjectRefresh | null = null;
  constructor(private identity: { projectId: string; accountId: string }, private changed: (state: ProjectChangeState) => void) {}
  establishSession(sessionId: string): void {
    if (this.disposed) return;
    if (this.sessionId && this.sessionId !== sessionId) { this.dispose(); return; }
    this.sessionId = sessionId;
    const early = this.early; this.early = [];
    for (const event of early) this.receive(event);
  }
  register(refresh: ProjectRefresh): void { this.refresh = refresh; this.generation += 1; }
  receive(event: ProjectChange): void {
    if (this.disposed || event.projectId !== this.identity.projectId || event.accountId !== this.identity.accountId || !Number.isSafeInteger(event.revision)) return;
    if (!this.sessionId) { this.early.push(event); return; }
    if (event.sessionId !== this.sessionId || event.revision < this.applied || (event.revision === this.applied && event.reason !== "resync")) return;
    // A missing/reordered revision may affect another document. A full refresh
    // makes advancing the cursor safe even when its earlier notification is late.
    if (this.applied < 0 || event.revision > this.applied + 1) event = { ...event, reason: "resync", documentIds: [] };
    const previous = this.pending;
    this.pending = previous ? {
      ...event, revision: Math.max(previous.revision, event.revision),
      reason: previous.reason === "resync" || event.reason === "resync" ? "resync" : "commit",
      documentIds: previous.documentIds.length && event.documentIds.length ? [...new Set([...previous.documentIds, ...event.documentIds])] : [],
      scopes: [...new Set([...previous.scopes, ...event.scopes])],
    } : { ...event, documentIds: [...event.documentIds], scopes: [...event.scopes] };
    this.generation += 1; this.error = ""; this.publish();
  }
  async flush(retry = false): Promise<void> {
    const refresh = this.refresh;
    if (this.disposed || this.busy || !this.pending || !refresh || refresh.blocked() || (this.error && !retry)) return;
    const event = this.pending, generation = this.generation, version = refresh.version();
    this.busy = true; this.error = ""; this.publish();
    try {
      const apply = await refresh.prepare(event);
      // No DOM or baseline changes are allowed before this second guard.
      if (this.disposed || generation !== this.generation || version !== refresh.version() || refresh.blocked()) return;
      apply();
      this.applied = event.revision; this.pending = null;
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.error = error instanceof Error ? error.message : t("변경 내용을 불러오지 못했습니다.");
    } finally { this.busy = false; if (!this.disposed) this.publish(); }
  }
  private publish(): void { this.changed({ pending: !!this.pending, busy: this.busy, error: this.error }); }
  dispose(): void { this.disposed = true; this.generation += 1; this.pending = null; this.early = []; }
}

export function projectRefreshHasFocus(): boolean {
  return !!document.querySelector("dialog[open]") || !!document.activeElement?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

/** Subscribed before page boot; the page registers its safe render boundary after boot. */
export function initProjectChanges(api: MunhaeApi, project: ProjectSummary): { register(refresh: ProjectRefresh): void } {
  if (project.storageMode !== "online") return { register: () => undefined };
  const button = document.createElement("button");
  button.type = "button"; button.className = "project-change-status"; button.hidden = true;
  const label = document.createElement("span"); label.setAttribute("role", "status"); button.append(label);
  const bar = document.querySelector(".statusbar");
  bar?.querySelector(".sp")?.before(button);
  if (!button.isConnected) bar?.append(button);
  const coordinator = new ProjectChangeCoordinator(project, state => {
    button.hidden = !state.pending; button.disabled = state.busy;
    label.textContent = state.busy ? t("변경 내용 불러오는 중…") : state.error ? t("변경 불러오기 실패 · 다시 시도") : t("다른 곳에서 변경됨");
    button.setAttribute("aria-label", label.textContent + " · " + t("변경 내용 다시 확인"));
    button.title = state.error || t("작성 중인 내용과 실행 중인 작업을 마치면 변경 내용을 반영합니다.");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void coordinator.flush(), 150); };
  // Optional only for older browser development bridges; native preload exposes onChanged.
  const unsubscribe = api.project.onChanged?.(event => { coordinator.receive(event); schedule(); }) ?? (() => undefined);
  const acceptStatus = (status: { projectId: string; sessionId: string } | null) => {
    if (status?.projectId === project.onlineProjectId) { coordinator.establishSession(status.sessionId); schedule(); }
  };
  const statusListener = (event: Event) => acceptStatus((event as CustomEvent).detail);
  document.addEventListener("munhae:online-workspace-status", statusListener);
  void api.onlineProjects.status().then(result => { if (!disposed && result.ok) acceptStatus(result.data); }).catch(() => undefined);
  // This timer checks only local dirty/busy guards; it never polls the server.
  const idle = setInterval(() => void coordinator.flush(), 1000);
  document.addEventListener("focusout", schedule);
  button.addEventListener("click", () => void coordinator.flush(true));
  const stop = () => {
    if (disposed) return;
    disposed = true; coordinator.dispose(); unsubscribe(); clearTimeout(timer); clearInterval(idle);
    document.removeEventListener("focusout", schedule); document.removeEventListener("munhae:online-workspace-status", statusListener);
  };
  const stopAccount = api.auth.onStateChanged(state => { if (state.status !== "signed_in" || state.user?.id !== project.accountId) stop(); });
  window.addEventListener("pagehide", () => { stop(); stopAccount(); }, { once: true });
  return { register(refresh) {
    coordinator.register({ ...refresh, blocked: () => projectRefreshHasFocus() || refresh.blocked() }); schedule();
  } };
}
