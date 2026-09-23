import type { MunhaeApi } from "../../shared/munhae-api";
import type { ProjectSharing, ProjectInvitation, OnlineProjectRole } from "../../shared/online-projects";
import "../styles/project-sharing.css";
import { t } from "./i18n";

type SharingApi = Pick<MunhaeApi["onlineProjects"], "sharing" | "invite" | "invitations" | "respond" | "cancelInvitation" | "updateMember">;
const esc = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const projectRoleLabel = (role: OnlineProjectRole) => t({ owner: "소유자", editor: "편집자", viewer: "열람자" }[role]);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : t("요청을 완료하지 못했습니다.");

/** Each dialog lifetime rejects responses from a previously selected project/account. */
export function createProjectSharing(api: SharingApi, root: Document = document) {
  const dialog = root.createElement("dialog"); dialog.className = "project-sharing-dialog"; dialog.setAttribute("aria-label", t("프로젝트 공유"));
  dialog.innerHTML = `<header class="dl-h"><b>${t("프로젝트 공유")}</b><button type="button" class="btn btn-ghost btn-sm" data-close>${t("닫기")}</button></header><div class="dl-b"><p data-status role="status"></p><div data-content></div><p data-error role="alert" hidden></p></div>`;
  root.body.append(dialog);
  const content = dialog.querySelector<HTMLElement>("[data-content]")!;
  const status = dialog.querySelector<HTMLElement>("[data-status]")!;
  const error = dialog.querySelector<HTMLElement>("[data-error]")!;
  let epoch = 0, projectId = "", title = "", busy = false;
  let sharing: ProjectSharing | null = null;
  function render() {
    if (!sharing) return;
    const owner = sharing.role === "owner";
    status.textContent = `${title} · ${sharing.usedSeats} / ${sharing.memberLimit}${t("명")}`;
    content.innerHTML = `<ul class="sharing-members">${sharing.members.map(member => `<li><div><b>${esc(member.displayName)}</b>${member.email ? `<small>${esc(member.email)}</small>` : ""}</div>${owner && member.role !== "owner" ? `<select class="select" aria-label="${esc(member.displayName)} ${t("권한")}" data-member-role="${esc(member.userId)}"><option value="editor" ${member.role === "editor" ? "selected" : ""}>${t("편집자")}</option><option value="viewer" ${member.role === "viewer" ? "selected" : ""}>${t("열람자")}</option></select><button type="button" class="btn btn-ghost btn-sm" data-remove="${esc(member.userId)}">${t("제거")}</button>` : `<span>${projectRoleLabel(member.role)}</span>`}</li>`).join("")}</ul>${owner ? `<section class="sharing-invite"><h3>${t("멤버 초대")}</h3><p class="muted">${t("소유자와 수락 대기 초대를 포함해 최대 5명입니다.")}</p>${!sharing.canInvite ? `<p>${t("멤버 초대는 소유자의 Premium 구독이 필요합니다.")} <a href="account.html">${t("구독 관리")}</a></p>` : !sharing.initialized ? `<p>${t("프로젝트를 한 번 연 뒤 초대할 수 있습니다.")}</p>` : `<form data-invite-form><input class="input" type="email" name="email" aria-label="${t("초대할 이메일")}" placeholder="${t("이메일 주소")}" maxlength="254" required><select class="select" name="role" aria-label="${t("초대 권한")}"><option value="viewer">${t("열람자")}</option><option value="editor">${t("편집자")}</option></select><button type="submit" class="btn btn-primary" ${sharing.usedSeats >= sharing.memberLimit ? "disabled" : ""}>${t("초대")}</button></form><p class="muted">${t("해당 이메일로 로그인한 멤버의 앱 받은 초대함에 표시됩니다. 초대는 7일간 유효하며 이메일은 별도로 발송하지 않습니다.")}</p>`}</section>${sharing.invitations.length ? `<h3>${t("수락 대기")}</h3><ul class="sharing-members">${sharing.invitations.map(invite => `<li><div><b>${esc(invite.email)}</b><small>${projectRoleLabel(invite.role)} · ${esc(new Date(invite.expiresAt).toLocaleDateString())} ${t("만료")}</small></div><button class="btn btn-ghost btn-sm" type="button" data-cancel-invite="${esc(invite.id)}">${t("초대 취소")}</button></li>`).join("")}</ul>` : ""}` : `<p class="muted">${t("멤버와 권한은 소유자가 관리합니다.")}</p>`}`;
  }
  async function reload(captured: number) {
    const result = await api.sharing(projectId);
    if (epoch !== captured) return;
    if (!result.ok) throw new Error(result.error.message);
    sharing = result.data; render();
  }
  async function run(action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    if (busy) return;
    const captured = epoch; busy = true; error.hidden = true;
    content.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("button,input,select").forEach(node => node.disabled = true);
    try {
      const result = await action();
      if (epoch !== captured) return;
      if (!result.ok) throw new Error(result.error?.message);
      await reload(captured);
    } catch (cause) {
      if (epoch === captured) { render(); error.textContent = errorMessage(cause); error.hidden = false; }
    } finally { if (epoch === captured) busy = false; }
  }
  dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { if (dialog.open) return; epoch++; busy = false; sharing = null; content.replaceChildren(); error.textContent = ""; status.textContent = ""; });
  content.addEventListener("submit", event => {
    const form = event.target as HTMLFormElement;
    if (!form.matches("[data-invite-form]")) return;
    event.preventDefault();
    const fields = new FormData(form);
    void run(() => api.invite({ projectId, email: String(fields.get("email")), role: fields.get("role") === "editor" ? "editor" : "viewer" }));
  });
  content.addEventListener("change", event => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.memberRole) { const userId = select.dataset.memberRole; const role = select.value === "editor" ? "editor" : "viewer"; void run(() => api.updateMember({ projectId, userId, role })); }
  });
  content.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const remove = event.target.closest<HTMLElement>("[data-remove]")?.dataset.remove;
    const cancel = event.target.closest<HTMLElement>("[data-cancel-invite]")?.dataset.cancelInvite;
    if (remove && window.confirm(t("이 멤버의 프로젝트 접근 권한을 제거하시겠습니까?"))) void run(() => api.updateMember({ projectId, userId: remove, role: null }));
    if (cancel) void run(() => api.cancelInvitation(cancel));
  });
  return {
    async open(id: string, name: string) {
      // Reuse an already open dialog; queued close events must not invalidate a new load.
      const captured = ++epoch; projectId = id; title = name; sharing = null; busy = false; content.replaceChildren(); error.hidden = true;
      status.textContent = t("공유 정보를 불러오는 중…"); if (!dialog.open) dialog.showModal();
      try { await reload(captured); } catch (cause) { if (epoch === captured) { status.textContent = name; error.textContent = errorMessage(cause); error.hidden = false; } }
    },
    close() { epoch++; dialog.close(); content.replaceChildren(); },
    dispose() { epoch++; dialog.remove(); },
  };
}

export function createProjectInvitationInbox(api: SharingApi, parent: HTMLElement, changed: () => void) {
  const section = document.createElement("section"); section.className = "project-invitations"; section.hidden = true; parent.before(section);
  let epoch = 0, account: string | null = null, busy = false;
  let invitations: ProjectInvitation[] = [];
  const render = (message = "") => {
    section.hidden = !account || (!invitations.length && !message);
    section.innerHTML = `<h3>${t("받은 초대")}</h3>${message ? `<p role="alert">${esc(message)}</p>` : ""}<ul class="sharing-members">${invitations.map(invite => `<li><div><b>${esc(invite.projectTitle)}</b><small>${projectRoleLabel(invite.role)} · ${esc(new Date(invite.expiresAt).toLocaleDateString())} ${t("만료")}</small></div><button class="btn btn-sm" data-accept="${esc(invite.id)}" ${busy ? "disabled" : ""}>${t("수락")}</button><button class="btn btn-ghost btn-sm" data-decline="${esc(invite.id)}" ${busy ? "disabled" : ""}>${t("거절")}</button></li>`).join("")}</ul>`;
  };
  async function refresh() {
    if (!account || busy) return;
    const captured = ++epoch;
    try { const result = await api.invitations(); if (captured !== epoch) return; if (!result.ok) throw new Error(result.error.message); invitations = result.data; render(); }
    catch (error) { if (captured === epoch) render(errorMessage(error)); }
  }
  section.addEventListener("click", async event => {
    if (busy || !(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>("[data-accept],[data-decline]");
    const id = button?.dataset.accept ?? button?.dataset.decline;
    if (!id) return;
    const captured = epoch; busy = true; render();
    try { const result = await api.respond({ invitationId: id, accept: !!button?.dataset.accept }); if (captured !== epoch) return; if (!result.ok) throw new Error(result.error.message); busy = false; await refresh(); changed(); }
    catch (error) { if (captured === epoch) { busy = false; render(errorMessage(error)); } }
  });
  return { refresh, setAccount(id: string | null) { epoch++; account = id; invitations = []; busy = false; render(); if (id) void refresh(); } };
}
