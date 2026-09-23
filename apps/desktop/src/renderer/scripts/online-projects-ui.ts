import { createProjectSharing, createProjectInvitationInbox, projectRoleLabel } from "./project-sharing-ui";
import type { AccountState, MunhaeApi, OnlineProject, ProjectSummary } from "../../shared/munhae-api";
import { t, ui } from "./i18n";

type OnlineProjectsApi = Pick<MunhaeApi["onlineProjects"], "list" | "create" | "get" | "open" | "exportRecovery">;
type CreateFields = { title: string; description: string };
export type OnlineProjectsState = {
  accountId: string | null;
  projects: OnlineProject[];
  loading: boolean;
  listError: string;
  submitting: boolean;
  createError: string;
  selectedId: string | null;
  project: OnlineProject | null;
  detailLoading: boolean;
  detailError: string;
  openingId: string | null;
  openId: string | null;
  openError: string;
  openErrorCode: string;
  recoveryBusy: boolean;
  recoveryMessage: string;
};

const emptyState = (): OnlineProjectsState => ({
  accountId: null, projects: [], loading: false, listError: "", submitting: false,
  createError: "", selectedId: null, project: null, detailLoading: false, detailError: "",
  openingId: null, openId: null, openError: "", openErrorCode: "", recoveryBusy: false, recoveryMessage: "",
});
const message = (error: unknown) => error instanceof Error ? error.message : t("요청을 완료하지 못했습니다. 다시 시도하세요.");

/** Account epochs keep responses from a previous session out of the current UI. */
export class OnlineProjectsController {
  state: OnlineProjectsState = emptyState();
  private epoch = 0;
  private listRequest = 0;
  private detailRequest = 0;
  private intent: { signature: string; requestId: string } | null = null;

  constructor(private api: OnlineProjectsApi, private changed: () => void, private uuid: () => string = () => crypto.randomUUID()) {}

  setAccount(accountId: string | null): void {
    if (accountId === this.state.accountId) return;
    this.epoch += 1;
    this.listRequest += 1;
    this.detailRequest += 1;
    this.intent = null;
    this.state = { ...emptyState(), accountId };
    this.changed();
  }

  async refresh(): Promise<void> {
    if (!this.state.accountId) return;
    const epoch = this.epoch;
    const request = ++this.listRequest;
    this.state.loading = true;
    this.state.listError = "";
    this.changed();
    try {
      const result = await this.api.list();
      if (epoch !== this.epoch || request !== this.listRequest) return;
      if (!result.ok) throw new Error(result.error.message);
      this.state.projects = result.data;
    } catch (error) {
      if (epoch !== this.epoch || request !== this.listRequest) return;
      this.state.listError = message(error);
    } finally {
      if (epoch === this.epoch && request === this.listRequest) {
        this.state.loading = false;
        this.changed();
      }
    }
  }

  async create(fields: CreateFields): Promise<OnlineProject | null> {
    if (!this.state.accountId || this.state.submitting) return null;
    const title = fields.title.trim();
    const description = fields.description.trim();
    if (!title || Array.from(title).length > 160 || Array.from(description).length > 4000) {
      this.state.createError = t("프로젝트 이름은 1~160자, 설명은 4,000자 이내로 입력하세요.");
      this.changed();
      return null;
    }
    const signature = JSON.stringify([title, description]);
    if (this.intent?.signature !== signature) this.intent = { signature, requestId: this.uuid() };
    const epoch = this.epoch;
    this.state.submitting = true;
    this.state.createError = "";
    this.changed();
    try {
      const result = await this.api.create({ title, description, requestId: this.intent.requestId });
      if (epoch !== this.epoch) return null;
      if (!result.ok) throw new Error(result.error.message);
      // A list requested before creation must not erase its successful server response.
      this.listRequest += 1;
      this.state.loading = false;
      this.state.listError = "";
      this.state.projects = [result.data, ...this.state.projects.filter(project => project.id !== result.data.id)];
      this.intent = null;
      return result.data;
    } catch (error) {
      if (epoch === this.epoch) this.state.createError = message(error);
      return null;
    } finally {
      if (epoch === this.epoch) {
        this.state.submitting = false;
        this.changed();
      }
    }
  }

  clearCreateError(): void {
    this.state.createError = "";
    this.changed();
  }

  async openWorkspace(id: string, discardLocal = false): Promise<ProjectSummary | null> {
    if (!this.state.accountId || this.state.openingId || this.state.recoveryBusy) return null;
    const epoch = this.epoch;
    this.state.openingId = id; this.state.openId = id;
    this.state.openError = ""; this.state.openErrorCode = ""; this.state.recoveryMessage = "";
    this.changed();
    try {
      const result = await this.api.open({ id, ...(discardLocal ? { discardLocal: true } : {}) });
      if (epoch !== this.epoch) return null;
      if (!result.ok) {
        this.state.openError = result.error.message;
        this.state.openErrorCode = result.error.code;
        return null;
      }
      return result.data;
    } catch (error) {
      if (epoch === this.epoch) this.state.openError = message(error);
      return null;
    } finally {
      if (epoch === this.epoch) { this.state.openingId = null; this.changed(); }
    }
  }

  async exportRecovery(): Promise<void> {
    if (!this.state.openId || !this.state.accountId || this.state.recoveryBusy || this.state.openingId) return;
    const epoch = this.epoch;
    this.state.recoveryBusy = true;
    this.changed();
    try {
      const result = await this.api.exportRecovery(this.state.openId);
      if (epoch !== this.epoch) return;
      this.state.recoveryMessage = result.ok ? (result.data ? ui`복구본을 저장했습니다 · ${result.data}` : "") : result.error.message;
    } catch (error) {
      if (epoch === this.epoch) this.state.recoveryMessage = message(error);
    } finally {
      if (epoch === this.epoch) { this.state.recoveryBusy = false; this.changed(); }
    }
  }

  async open(id: string): Promise<void> {
    if (!this.state.accountId) return;
    const epoch = this.epoch;
    const request = ++this.detailRequest;
    this.state.selectedId = id;
    this.state.project = null;
    this.state.detailLoading = true;
    this.state.detailError = "";
    this.changed();
    try {
      const result = await this.api.get(id);
      if (epoch !== this.epoch || request !== this.detailRequest) return;
      if (!result.ok) throw new Error(result.error.message);
      this.state.project = result.data;
      this.state.projects = this.state.projects.map(project => project.id === id ? result.data : project);
    } catch (error) {
      if (epoch === this.epoch && request === this.detailRequest) this.state.detailError = message(error);
    } finally {
      if (epoch === this.epoch && request === this.detailRequest) {
        this.state.detailLoading = false;
        this.changed();
      }
    }
  }

  closeDetails(): void {
    this.detailRequest += 1;
    this.state.selectedId = null;
    this.state.project = null;
    this.state.detailLoading = false;
    this.state.detailError = "";
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const cloudIcon = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 12.5H12a2.75 2.75 0 0 0 .4-5.47A4.5 4.5 0 0 0 3.6 6a3.3 3.3 0 0 0 .9 6.5Z"/></svg>';
const dateLabel = (date: string) => new Intl.DateTimeFormat(document.documentElement.lang || "ko", { year: "numeric", month: "short", day: "numeric" }).format(new Date(date));

export function configureOnlineProjects(api: MunhaeApi["onlineProjects"], root: Document = document) {
  const element = <T extends HTMLElement>(id: string) => root.getElementById(id) as T;
  const list = element<HTMLDivElement>("onlineProjectList");
  const count = element<HTMLSpanElement>("onlineProjectCount");
  const createButton = element<HTMLButtonElement>("btnCreateOnlineProject");
  const refreshButton = element<HTMLButtonElement>("btnRefreshOnlineProjects");
  const createDialog = element<HTMLDialogElement>("dlgCreateOnlineProject");
  const form = element<HTMLFormElement>("createOnlineProjectForm");
  const title = element<HTMLInputElement>("onlineProjectTitle");
  const description = element<HTMLTextAreaElement>("onlineProjectDescription");
  const submit = element<HTMLButtonElement>("btnSubmitOnlineProject");
  const cancel = element<HTMLButtonElement>("btnCancelOnlineProject");
  const createError = element<HTMLParagraphElement>("onlineProjectCreateError");
  const infoDialog = element<HTMLDialogElement>("dlgOnlineProjectInfo");
  const info = element<HTMLDivElement>("onlineProjectInfoContent");
  let accountLabel = "";
  let accountKnown = false;
  let openMode = false;
  const controller = new OnlineProjectsController(api, render);
  const sharing = createProjectSharing(api, root);
  const inbox = createProjectInvitationInbox(api, list, () => void controller.refresh());

  function render(): void {
    const state = controller.state;
    createButton.disabled = !state.accountId || !!state.openingId;
    refreshButton.disabled = !state.accountId || state.loading;
    list.setAttribute("aria-busy", String(state.loading));
    count.textContent = state.accountId && !state.loading ? ui`${state.projects.length}개` : "";
    const rows = state.projects.map(project => ui`<div class="online-project-row"><button class="online-project-item" type="button" data-online-project="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.title)} · ${escapeHtml(t("프로젝트 열기"))}" ${state.openingId ? "disabled" : ""}><span class="online-project-icon">${cloudIcon}</span><span class="online-project-copy"><b>${escapeHtml(project.title)}</b><small>${project.description ? escapeHtml(project.description) : t("설명 없음")}</small></span><span class="online-project-meta"><time datetime="${escapeHtml(project.updatedAt)}">${escapeHtml(dateLabel(project.updatedAt))}</time><span>${state.openingId === project.id ? t("여는 중…") : t("열기")} <span aria-hidden="true">›</span></span></span></button><button class="btn btn-ghost btn-sm online-project-info-button" type="button" data-online-info="${escapeHtml(project.id)}" aria-label="${escapeHtml(project.title)} · ${escapeHtml(t("프로젝트 정보"))}" ${state.openingId ? "disabled" : ""}><svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4v1"/></svg></button></div>`).join("");
    let status = "";
    if (!accountKnown) status = ui`<p class="w-project-empty">계정을 확인하고 있습니다.</p>`;
    else if (!state.accountId) status = ui`<p class="w-project-empty">로그인하면 온라인 프로젝트를 볼 수 있습니다. <a href="account.html">로그인</a></p>`;
    else if (state.listError) status = ui`<div class="online-project-list-error" role="alert"><p>${escapeHtml(state.listError)}</p><button type="button" class="btn btn-sm" data-online-retry>다시 시도</button></div>`;
    else if (state.loading) status = ui`<p class="w-project-empty">프로젝트를 불러오는 중…</p>`;
    else if (!state.projects.length) status = ui`<p class="w-project-empty">아직 온라인 프로젝트가 없습니다.</p>`;
    const owned = state.projects.filter(project => project.role === "owner");
    const shared = state.projects.filter(project => project.role !== "owner");
    // Row rendering preserves escaping and event delegation; partition into clear account scopes.
    const holder = root.createElement("div"); holder.innerHTML = rows;
    const rowMap = new Map(Array.from(holder.children).map(row => [(row.querySelector("[data-online-project]") as HTMLElement)?.dataset.onlineProject, row.outerHTML]));
    list.innerHTML = (owned.length ? `<div class="online-project-group-label">${t("내 프로젝트")}</div>` + owned.map(p => rowMap.get(p.id)).join("") : "")
      + (shared.length ? `<div class="online-project-group-label">${t("공유받은 프로젝트")}</div>` + shared.map(p => rowMap.get(p.id)).join("") : "") + status;
    for (const input of [title, description, cancel, submit]) input.disabled = state.submitting;
    submit.textContent = state.submitting ? t("만드는 중…") : t("만들기");
    createError.textContent = state.createError;
    createError.hidden = !state.createError;
    form.setAttribute("aria-busy", String(state.submitting));
    element("onlineProjectAccount").textContent = accountLabel ? ui`${accountLabel} 계정에 저장됩니다.` : "";
    element("onlineProjectInfoHeading").textContent = openMode ? t("온라인 프로젝트 열기") : t("온라인 프로젝트 정보");
    element<HTMLButtonElement>("btnCloseOnlineProjectInfo").disabled = !!state.openingId || state.recoveryBusy;
    if (openMode) {
      const conflict = state.openErrorCode === "online_workspace_conflict";
      info.innerHTML = state.openingId ? ui`<p class="online-project-loading">프로젝트를 여는 중…</p>` : state.openError ? ui`<p class="online-project-error" role="alert">${escapeHtml(state.openError)}</p><div class="online-project-open-actions"><button class="btn" type="button" data-open-retry ${state.recoveryBusy ? "disabled" : ""}>다시 시도</button>${conflict ? ui`<button class="btn" type="button" data-open-recovery ${state.recoveryBusy ? "disabled" : ""}>${state.recoveryBusy ? t("내보내는 중…") : t("복구본 내보내기")}</button><button class="btn" type="button" data-open-server ${state.recoveryBusy ? "disabled" : ""}>서버 버전으로 열기</button>` : ""}</div>${state.recoveryMessage ? ui`<p class="online-project-account" role="status">${escapeHtml(state.recoveryMessage)}</p>` : ""}` : "";
    }
    else if (state.detailLoading) info.innerHTML = ui`<p class="online-project-loading">프로젝트 정보를 불러오는 중…</p>`;
    else if (state.detailError) info.innerHTML = ui`<div class="online-project-list-error" role="alert"><p>${escapeHtml(state.detailError)}</p><button class="btn btn-sm" type="button" data-online-detail-retry>다시 시도</button></div>`;
    else if (state.project) {
      const project = state.project;
      info.innerHTML = ui`<div class="online-project-detail-name">${cloudIcon}<h2>${escapeHtml(project.title)}</h2></div><p class="online-project-description${project.description ? "" : " muted"}">${project.description ? escapeHtml(project.description) : t("설명 없음")}</p><dl class="online-project-facts"><div><dt>저장 위치</dt><dd>온라인</dd></div><div><dt>내 권한</dt><dd>${projectRoleLabel(project.role)}</dd></div><div><dt>생성일</dt><dd>${escapeHtml(dateLabel(project.createdAt))}</dd></div><div><dt>최근 변경</dt><dd>${escapeHtml(dateLabel(project.updatedAt))}</dd></div></dl><button class="btn" type="button" data-project-sharing>${t("공유 및 멤버")}</button>`;
    } else info.replaceChildren();
  }

  const showProject = (id: string) => {
    openMode = false;
    void controller.open(id);
    if (!infoDialog.open) infoDialog.showModal();
  };
  const openProject = async (id: string, discardLocal = false) => {
    if (controller.state.openingId || controller.state.recoveryBusy) return;
    openMode = true;
    const pending = controller.openWorkspace(id, discardLocal);
    if (!infoDialog.open) infoDialog.showModal();
    const project = await pending;
    if (project) location.href = "home.html";
    else if (!controller.state.openError) infoDialog.close();
  };
  infoDialog.addEventListener("cancel", event => { if (controller.state.openingId || controller.state.recoveryBusy) event.preventDefault(); });
  createButton.addEventListener("click", () => {
    if (!controller.state.accountId) return;
    controller.clearCreateError();
    createDialog.showModal();
    title.focus();
  });
  cancel.addEventListener("click", () => createDialog.close());
  createDialog.addEventListener("cancel", event => { if (controller.state.submitting) event.preventDefault(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const project = await controller.create({ title: title.value, description: description.value });
    if (!project) return;
    createDialog.close();
    form.reset();
    void openProject(project.id);
  });
  refreshButton.addEventListener("click", () => { void controller.refresh(); void inbox.refresh(); });
  list.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const item = event.target.closest<HTMLElement>("[data-online-project]");
    const infoButton = event.target.closest<HTMLElement>("[data-online-info]");
    if (item?.dataset.onlineProject) void openProject(item.dataset.onlineProject);
    else if (infoButton?.dataset.onlineInfo) showProject(infoButton.dataset.onlineInfo);
    else if (event.target.closest("[data-online-retry]")) void controller.refresh();
  });
  element("btnCloseOnlineProjectInfo").addEventListener("click", () => infoDialog.close());
  infoDialog.addEventListener("close", () => controller.closeDetails());
  info.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-project-sharing]") && controller.state.project) { const project = controller.state.project; infoDialog.close(); void sharing.open(project.id, project.title); }
    if (event.target.closest("[data-online-detail-retry]") && controller.state.selectedId) void controller.open(controller.state.selectedId);
    if (event.target.closest("[data-open-retry]") && controller.state.openId) void openProject(controller.state.openId);
    if (event.target.closest("[data-open-recovery]")) void controller.exportRecovery();
    if (event.target.closest("[data-open-server]") && controller.state.openId && window.confirm(t("이 기기의 미전송 변경을 버리고 서버 버전으로 다시 여시겠습니까? 보관할 변경이 있다면 먼저 복구본을 내보내세요."))) void openProject(controller.state.openId, true);
  });

  return {
    accountChanged(state: AccountState): void {
      const accountId = state.status === "signed_in" ? state.user?.id ?? null : null;
      const changed = accountId !== controller.state.accountId;
      accountKnown = true;
      accountLabel = state.user?.email || state.user?.displayName || "";
      if (changed) {
        openMode = false;
        sharing.close(); inbox.setAccount(accountId);
        createDialog.close();
        infoDialog.close();
        form.reset();
      }
      controller.setAccount(accountId);
      render();
      if (changed && accountId) void controller.refresh();
    },
    accountUnavailable(error: string): void {
      accountKnown = true;
      sharing.close(); inbox.setAccount(null);
      controller.setAccount(null);
      render();
      list.innerHTML = ui`<p class="w-project-empty" role="alert">${escapeHtml(error)} <a href="account.html">계정 확인</a></p>`;
    },
  };
}
