import type { RecentProject } from "../../shared/munhae-api";
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

function bindAssets(): void {
  const img = $("#appIconImg") as HTMLImageElement | null;
  if (!img) return;
  const fail = (): void => {
    $("#appIcon")?.classList.add("is-fallback");
    const glyph = $("#appIconGlyph");
    if (glyph) glyph.hidden = false;
  };
  img.addEventListener("error", fail);
  if (img.complete && img.naturalWidth === 0) fail();
}

function renderRecent(): void {
  const box = $("#recentList");
  if (!box) return;
  const seed = $("#btnSeedDemo");
  if (seed) seed.hidden = recent.length > 0;
  if (!recent.length) {
    box.innerHTML = '<p class="muted" style="padding:8px 10px;font-size:12px">최근 프로젝트가 없습니다. 새 프로젝트를 만들거나 훈민정음 데모를 여세요.</p>';
    bindItems();
    return;
  }
  box.innerHTML = recent
    .map((r, i) => {
      const missing = r.missing ? " is-missing" : "";
      const selCls = i === 0 ? " is-sel" : "";
      return `<button class="w-item${selCls}${missing}" type="button" data-recent="${esc(r.packagePath)}" data-od-id="recent-project">
        <div class="w-ico" aria-hidden="true">文</div>
        <div><b>${esc(r.displayName)}</b><span class="muted mono">${esc(shortPath(r.packagePath))}${r.missing ? " · 없음" : ""}</span></div>
        <span class="w-meta">${esc(fmtWhen(r.lastOpenedAt))}</span>
      </button>`;
    })
    .join("");
  bindItems();
}

function bindItems(): void {
  items = $$(".w-item");
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
    notify("이 경로의 프로젝트를 찾을 수 없습니다", "최근 프로젝트");
    return;
  }
  const result = await api.project.open(path);
  if (!result.ok) {
    notify(result.error.message, "프로젝트 열기");
    return;
  }
  if (result.data) location.href = "home.html";
}

function pageKeys(e: KeyboardEvent, _m: boolean): void {
  const pal = $("#dlgPalette") as HTMLDialogElement | null;
  if (pal?.open) return;
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
  bindAssets();
  const ver = $("#verLine");
  try {
    const v = await api.app.getVersion();
    if (ver) ver.textContent = `버전 ${v} · Phase 1 로컬 CAT`;
  } catch {
    /* keep fallback */
  }
  try {
    const cfg = await api.app.getConfig();
    const chk = $("#chkWelcome") as HTMLInputElement | null;
    if (chk) {
      chk.checked = cfg.showWelcomeOnLaunch;
      chk.addEventListener("change", () => {
        void api.app.setConfig({ showWelcomeOnLaunch: chk.checked });
      });
    }
  } catch {
    /* ignore */
  }
  try {
    recent = await api.project.listRecent();
  } catch {
    recent = [];
  }
  renderRecent();
  $$(".w-act").forEach((b) => {
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

void boot();
