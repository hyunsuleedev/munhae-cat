import { t, uiText } from "./i18n";
import { createBrowserApi } from "./browser-api";
import { accountGateUrl, AuthGate } from "./auth-gate";
import { installPageTransition } from "./page-transition";
import { initializeLanguage } from "./i18n";

const transition = installPageTransition(window, document.documentElement, () => {
  const panel = document.querySelector<HTMLElement>(".auth-gate");
  if (panel) panel.hidden = false;
});

const pages: Record<string, () => Promise<unknown>> = {
  "index.html": () => import("./welcome"),
  "home.html": () => import("./home"),
  "editor.html": () => import("./editor"),
  "context.html": () => import("./context"),
  "knowledge.html": () => import("./knowledge"),
  "glossary.html": () => import("./knowledge"),
  "comments.html": () => import("./knowledge"),
  "settings.html": () => import("./settings"),
  "community.html": () => import("./community"),
};

async function boot(): Promise<void> {
  const page = location.pathname.split("/").pop() || "index.html";
  const api = window.munhae ?? createBrowserApi();
  await initializeLanguage(api);
  if (page === "account.html") { transition.dispose(); await import("./account"); return; }
  const load = pages[page];
  if (!load) throw new Error(t("알 수 없는 화면입니다."));
  const destination = () => accountGateUrl(`${page}${location.search}${location.hash}`);
  const panel = document.createElement("section");
  panel.className = "auth-gate";
  panel.hidden = true;
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "polite");
  panel.innerHTML = uiText('<strong class="hanmun">文解</strong><p>로그인 상태를 확인하고 있습니다.</p><button class="btn" type="button" hidden>다시 확인</button>');
  document.body.append(panel);
  const message = panel.querySelector("p")!;
  const button = panel.querySelector("button")!;
  let needsLogin = false;
  let pendingFeedback: number | undefined;
  const clearFeedback = () => {
    window.clearTimeout(pendingFeedback);
    pendingFeedback = undefined;
  };
  // Main restores the session once. Later navigations receive its current
  // snapshot, so keep this short page-initialization gap visually quiet.
  const showPending = () => {
    clearFeedback();
    transition.pending();
    document.body.dataset.authPending = "";
    panel.hidden = true;
    pendingFeedback = window.setTimeout(() => { panel.hidden = false; }, 200);
  };
  const block = (text: string) => {
    clearFeedback();
    document.body.dataset.authPending = "";
    panel.hidden = false;
    message.textContent = text;
    transition.finish();
  };
  const gate = new AuthGate(api.auth, {
    load: () => { message.textContent = t("화면을 준비하고 있습니다."); return load(); },
    reveal: () => {
      clearFeedback();
      needsLogin = false;
      delete document.body.dataset.authPending;
      panel.hidden = true;
      transition.finish();
    },
    requireAccount: () => {
      block(t("계속하려면 문해 계정으로 로그인하세요."));
      button.hidden = false;
      button.textContent = t("로그인");
      if (!needsLogin) { needsLogin = true; location.replace(destination()); }
    },
    failed: (error) => {
      needsLogin = false;
      block(error instanceof Error ? error.message : t("로그인 상태를 확인하지 못했습니다. 다시 시도하세요."));
      button.hidden = false;
      button.textContent = t("다시 확인");
    },
  });
  button.addEventListener("click", () => {
    if (needsLogin) { location.replace(destination()); return; }
    button.hidden = true;
    message.textContent = t("로그인 상태를 확인하고 있습니다.");
    showPending();
    void gate.check();
  });
  window.addEventListener("pagehide", (event) => {
    clearFeedback();
    if (!event.persisted) { gate.dispose(); transition.dispose(); }
  });
  window.addEventListener("pageshow", (event) => {
    // BFCache freezes event delivery. Read the latest local snapshot on return;
    // ordinary focus and navigation never trigger an Auth-server recheck.
    if (event.persisted) { message.textContent = t("로그인 상태를 확인하고 있습니다."); showPending(); void gate.check(); }
  });
  showPending();
  await gate.start();
}

void boot().catch(() => {
  // Keep protected content hidden if loading an entry module fails.
  const panel = document.querySelector<HTMLElement>(".auth-gate");
  if (panel) {
    panel.hidden = false;
    const message = panel.querySelector("p");
    if (message) message.textContent = t("화면을 불러오지 못했습니다. 앱을 다시 열어 주세요.");
  }
  transition.finish();
});
