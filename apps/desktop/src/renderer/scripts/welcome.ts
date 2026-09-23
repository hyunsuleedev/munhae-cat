import { t, uiText, ui } from "./i18n";
import type { RecentProject } from "../../shared/munhae-api";
import { configureOnlineProjects } from "./online-projects-ui";
import {
  $,
  $$,
  currentDocId,
  esc,
  fmtWhen,
  initShell,
  notify,
  persistDoc,
  requireApi,
  shortPath,
} from "./shared";

const api = requireApi();
const { cmd: run } = initShell({
  page: "welcome",
  extraEnabled: ["newproj", "open", "seeddemo"],
  pageKeys,
});

let recent: RecentProject[] = [];
let items: HTMLElement[] = [];
let sel = 0;

function renderRecent(): void {
  const box = $("#recentList");
  if (!box) return;
  const seed = $("#btnSeedDemo");
  if (seed) seed.hidden = recent.length > 0;
  if (!recent.length) {
    box.innerHTML = uiText('<p class="muted" style="padding:8px 10px;font-size:12px">최근 프로젝트가 없습니다. 새 프로젝트를 만들거나 훈민정음 데모를 여세요.</p>');
    bindItems();
    return;
  }
  box.innerHTML = recent
    .map((r, i) => {
      const missing = r.missing ? " is-missing" : "";
      const selCls = i === 0 ? " is-sel" : "";
      return `<button class="w-item${selCls}${missing}" type="button" data-recent="${esc(r.packagePath)}" data-od-id="recent-project">
        <div class="w-ico" aria-hidden="true">文</div>
        <div><b>${esc(r.displayName)}</b><span class="muted mono">${esc(shortPath(r.packagePath))}${r.missing ? t(" · 없음") : ""}</span></div>
        <span class="w-meta">${esc(fmtWhen(r.lastOpenedAt))}</span>
      </button>`;
    })
    .join("");
  bindItems();
}

function bindItems(): void {
  items = $$("#recentList .w-item");
  items.forEach((it, i) => {
    it.addEventListener("mouseenter", () => setSel(i));
  });
  setSel(0);
}

function setSel(i: number): void {
  if (!items.length) return;
  sel = ((i % items.length) + items.length) % items.length;
  items.forEach((it, j) => it.classList.toggle("is-sel", j === sel));
}

async function openRecent(path: string, missing: boolean): Promise<void> {
  if (missing) {
    notify(t("이 경로의 프로젝트를 찾을 수 없습니다"), t("최근 프로젝트"));
    return;
  }
  const result = await api.project.open(path);
  if (!result.ok) {
    notify(result.error.message, t("프로젝트 열기"));
    return;
  }
  if (result.data) location.href = "home.html";
}

function pageKeys(e: KeyboardEvent, _m: boolean): void {
  const pal = $("#dlgPalette") as HTMLDialogElement | null;
  if (pal?.open || document.querySelector("dialog[open]")) return;
  if (e.target instanceof HTMLElement && e.target.matches("input,textarea,button,[contenteditable=true]")) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setSel(sel + 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setSel(sel - 1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    items[sel]?.click();
  }
}

async function boot(): Promise<void> {
  const onlineProjects = configureOnlineProjects(api.onlineProjects);
  const renderAccount = (state: Awaited<ReturnType<typeof api.auth.getState>>) => {
    if (!state.ok) {
      onlineProjects.accountUnavailable(state.error.message);
      return;
    }
    onlineProjects.accountChanged(state.data);
    const user = state.data.user;
    const label = $("#welcomeAccountLabel");
    const link = $("#welcomeAccountLink");
    const signup = $("#welcomeSignUpLink");
    if (label) label.textContent = user ? ui`${user.displayName || user.email} · 로그인됨` : t("문해 계정");
    if (link) {
      link.textContent = user ? t("계정 설정") : t("로그인");
      link.setAttribute("href", user ? "settings.html#account" : "account.html");
    }
    if (signup) signup.hidden = !!user;
  };
  let accountEvent = 0;
  const accountRequest = accountEvent;
  api.auth.onStateChanged((state) => {
    accountEvent += 1;
    renderAccount({ ok: true, data: state });
  });
  void api.auth.getState().then(state => {
    if (accountRequest === accountEvent) renderAccount(state);
  }).catch(() => {
    if (accountRequest === accountEvent) onlineProjects.accountUnavailable(t("계정을 확인하지 못했습니다."));
  });
  const ver = $("#verLine");
  try {
    const v = await api.app.getVersion();
    if (ver) ver.textContent = ui`버전 ${v}`;
  } catch {
    /* keep fallback */
  }
  try {
    recent = await api.project.listRecent();
  } catch {
    recent = [];
  }
  renderRecent();
  $$(".w-act[data-cmd]").forEach((b) => {
    b.addEventListener("click", () => {
      void run(b.dataset.cmd ?? "");
    });
  });
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const recentBtn = t.closest("[data-recent]");
    if (recentBtn instanceof HTMLElement) {
      const path = recentBtn.dataset.recent ?? "";
      const missing = recentBtn.classList.contains("is-missing");
      void openRecent(path, missing);
    }
  });
  const persisted = currentDocId();
  if (persisted) persistDoc(persisted);
}

await boot();
