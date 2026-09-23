import type { MunhaeApi, ProjectSummary } from "../../shared/munhae-api";
import { t } from "./i18n";

type Action = { label: string; run: () => void; shortcut?: string; disabled?: boolean; title?: string } | null;
type Deps = {
  api: MunhaeApi;
  project: () => ProjectSummary | null;
  command: (id: string) => Promise<void>;
  openProject: (path: string) => Promise<void>;
  error: (message: string) => void;
};

/** The shared sidebar owns app actions; menus are overlays, so the tree never moves. */
export function mountSidebarChrome(deps: Deps): () => void {
  const sidebar = document.querySelector<HTMLElement>("#sidebar");
  if (!sidebar) return () => {};
  let menu: HTMLElement | null = null;
  let owner: HTMLButtonElement | null = null;
  let revision = 0;
  const close = (restore = false) => {
    revision++;
    menu?.remove(); menu = null;
    owner?.setAttribute("aria-expanded", "false");
    if (restore) owner?.focus({ preventScroll: true });
    owner = null;
  };
  const invoke = (id: string) => () => { void deps.command(id).catch(error => deps.error(String(error))); };
  const position = () => {
    if (!menu || !owner) return;
    const rect = owner.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, rect.bottom + menu.offsetHeight + 5 > innerHeight ? rect.top - menu.offsetHeight - 5 : rect.bottom + 5)}px`;
  };
  const show = (trigger: HTMLButtonElement, actions: Action[]) => {
    close(); owner = trigger;
    trigger.setAttribute("aria-expanded", "true");
    const popup = document.createElement("div");
    popup.className = "sb-app-menu";
    popup.id = "sbAppMenu";
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-label", trigger.getAttribute("aria-label") ?? trigger.textContent ?? "");
    for (const action of actions) {
      if (!action) { const separator = document.createElement("hr"); separator.setAttribute("role", "separator"); popup.append(separator); continue; }
      const button = document.createElement("button");
      button.type = "button"; button.setAttribute("role", "menuitem"); button.tabIndex = -1;
      button.disabled = !!action.disabled;
      const label = document.createElement("span"); label.textContent = action.label; button.append(label);
      button.title = action.title ?? action.label;
      if (action.shortcut) { const kbd = document.createElement("kbd"); kbd.textContent = action.shortcut; button.append(kbd); }
      button.onclick = () => { close(true); action.run(); };
      popup.append(button);
    }
    document.body.append(popup); menu = popup; position();
    popup.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    popup.addEventListener("keydown", event => {
      const buttons = [...popup.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(true); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus({ preventScroll: true });
      }
    });
  };
  const button = (label: string, content: string, kind: string) => {
    const element = document.createElement("button");
    element.type = "button"; element.className = "sb-app-trigger";
    element.dataset.sbApp = kind; element.textContent = content;
    element.title = label; element.setAttribute("aria-label", label);
    element.setAttribute("aria-haspopup", "menu"); element.setAttribute("aria-expanded", "false");
    element.setAttribute("aria-controls", "sbAppMenu");
    return element;
  };
  const header = document.createElement("div"); header.className = "sb-project-actions";
  const projectButton = button(t("프로젝트 전환"), "", "project");
  const projectName = document.createElement("span"); projectName.className = "sb-project-name";
  const chevron = document.createElement("span"); chevron.textContent = "⌄"; chevron.setAttribute("aria-hidden", "true");
  projectButton.append(projectName, chevron); projectButton.classList.add("sb-project-switch");
  const more = button(t("프로젝트 관리"), "⋯", "manage");
  header.append(projectButton, more);
  const brand = sidebar.querySelector(".munhae-brand");
  if (brand) brand.after(header); else sidebar.querySelector("#sbTree")?.before(header);
  const help = button(t("도움말"), "", "help"); help.classList.add("sb-item", "sb-help");
  const helpIcon = document.createElement("span"); helpIcon.className = "sb-help-icon"; helpIcon.textContent = "?"; helpIcon.setAttribute("aria-hidden", "true");
  const helpLabel = document.createElement("span"); helpLabel.textContent = t("도움말");
  help.append(helpIcon, helpLabel);
  sidebar.querySelector(".sb-account")?.before(help);
  const command = (label: string, id: string, shortcut?: string): Action => ({ label: t(label), run: invoke(id), shortcut });
  const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
  const shiftMod = navigator.platform.includes("Mac") ? "⇧⌘" : "Ctrl+Shift+";
  const projectActions = (): Action[] => [
    command("새 프로젝트…", "newproj", `${shiftMod}N`), command("프로젝트 열기…", "open", `${mod}O`),
    ...(deps.project() ? [command("모든 프로젝트…", "projects")] : []),
  ];
  sidebar.addEventListener("click", event => {
    const trigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sb-app]");
    if (!trigger || trigger.disabled) return;
    event.preventDefault(); event.stopPropagation();
    if (owner === trigger) { close(true); return; }
    switch (trigger.dataset.sbApp) {
      case "project": {
        show(trigger, projectActions());
        const request = revision;
        void deps.api.project.listRecent().then(recent => {
          if (request !== revision || owner !== trigger) return;
          const others = recent.filter(item => item.packagePath !== deps.project()?.packagePath).slice(0, 8);
          if (!others.length) return;
          const focused = menu?.querySelectorAll("button");
          const index = focused ? [...focused].indexOf(document.activeElement as HTMLButtonElement) : -1;
          show(trigger, [...projectActions(), null, ...others.map(item => ({
            label: item.displayName, title: item.missing ? t("프로젝트 파일을 찾을 수 없습니다") : item.displayName,
            disabled: item.missing, run: () => { void deps.openProject(item.packagePath).catch(error => deps.error(String(error))); },
          }))]);
          if (index >= 0) menu?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus({ preventScroll: true });
        }).catch(error => { if (request === revision) deps.error(error instanceof Error ? error.message : t("프로젝트 목록을 불러오지 못했습니다")); });
        break;
      }
      case "manage":
        if (deps.project()) show(trigger, [command("백업 만들기…", "backup"), command("내보내기…", "export", `${mod}E`), null, command("프로젝트 닫기", "close", `${mod}W`)]);
        break;
      case "add":
        if (deps.project()) show(trigger, [command("새 문서", "newdoc", `${mod}N`), command("새 폴더", "newfolder"), null, command("원문 가져오기…", "import")]);
        break;
      case "help":
        show(trigger, [command("사용 안내·단축키", "help"), command("명령 검색…", "palette", `${mod}K`), null, command("업데이트 확인…", "updates"), command("문해 정보", "about")]);
        break;
    }
  });
  sidebar.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const trigger = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sb-app]");
    if (trigger) { event.preventDefault(); trigger.click(); }
  });
  document.addEventListener("pointerdown", event => {
    if (menu && !menu.contains(event.target as Node) && !owner?.contains(event.target as Node)) close();
  }, true);
  window.addEventListener("resize", () => close());
  document.addEventListener("scroll", event => {
    // Only scrolling the trigger's container changes its anchor. Unrelated
    // editor/settings scroll events must not dismiss a freshly opened menu.
    if (menu && owner && event.target instanceof Element && event.target.contains(owner)) close();
  }, true);
  return () => {
    const project = deps.project();
    projectName.textContent = project?.title ?? t("프로젝트 열기…");
    projectButton.title = project ? `${project.title} · ${t("프로젝트 전환")}` : t("프로젝트 열기…");
    more.hidden = !project;
    sidebar.querySelectorAll<HTMLButtonElement>('[data-sb-app="add"]').forEach(control => { control.hidden = !project; });
  };
}

export function showAppHelp(escape: (value: unknown) => string): void {
  let dialog = document.querySelector<HTMLDialogElement>("#dlgAppHelp");
  if (!dialog) {
    dialog = document.createElement("dialog"); dialog.id = "dlgAppHelp"; dialog.className = "app-help";
    dialog.setAttribute("aria-labelledby", "appHelpTitle");
    const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";
    const shiftMod = navigator.platform.includes("Mac") ? "⇧⌘" : "Ctrl+Shift+";
    const shortcuts = [["문서 찾기", `${mod}P`], ["찾기·바꾸기", `${mod}F`], ["명령 검색", `${mod}K`], ["새 문서", `${mod}N`], ["저장", `${mod}S`], ["실행 취소", `${mod}Z`], ["다시 실행", `${shiftMod}Z`], ["복사", `${mod}C`], ["붙여넣기", `${mod}V`], ["내보내기", `${mod}E`], ["설정", `${mod},`]];
    dialog.innerHTML = `<form method="dialog"><div class="dl-h" id="appHelpTitle">${escape(t("사용 안내·단축키"))}</div><div class="dl-b">
      <p>${escape(t("프로젝트 이름을 눌러 프로젝트를 전환하고, 옆의 ⋯ 메뉴에서 백업·내보내기를 실행하세요."))}</p>
      <p>${escape(t("문서 옆의 + 버튼으로 원문이나 폴더를 추가하세요. 문서별 ⋯ 메뉴에서 이름과 위치를 바꿀 수 있습니다."))}</p>
      <p>${escape(t("문서를 열면 원문·표점·번역 작업을 이어갈 수 있습니다. 화면 보기와 참고 자료·AI 패널은 편집기에서 조절하세요."))}</p>
      <dl class="app-help-shortcuts">${shortcuts.map(([label, key]) => `<div><dt>${escape(t(label!))}</dt><dd><kbd>${escape(key)}</kbd></dd></div>`).join("")}</dl>
      <p class="muted">${escape(t("단축키는 현재 화면에서 사용할 수 있는 기능에만 적용됩니다."))}</p>
      </div><div class="dl-f"><button class="btn btn-primary" value="close">${escape(t("닫기"))}</button></div></form>`;
    document.body.append(dialog);
  }
  if (!dialog.open) dialog.showModal();
}
