import { bindSidebarActions } from "./sidebar-actions";
import { SidebarNavigation } from "./sidebar-navigation";
import { mountSidebarChrome, showAppHelp } from "./sidebar-chrome";
import { initOnlineWorkspace, projectDocumentKey, projectLocationLabel } from "./online-workspace-ui";
import "../styles/online-workspace.css";
import { initProjectChanges, type ProjectRefresh } from "./project-change-ui";
import { initMcpChanges } from "./mcp-change-ui";
import "../styles/project-change.css";
import { filterSidebarBranches, sidebarAncestors } from "./sidebar-model";
import { t, ui, uiText } from "./i18n";
import { initNotificationSounds } from "./notification-sounds";
import { initBackgroundMusic } from "./background-music";
import type {
  AccountState,
  AgentProbe,
  AppConfig,
  DocumentListItem,
  DocumentNodeRole,
  IpcResult,
  MunhaeApi,
  ProjectSummary,
  VersionUiState,
} from "../../shared/munhae-api";
import { createBrowserApi } from "./browser-api";
import {
  configureProjectTools,
  openExport,
  openProjectSearch,
} from "./project-tools";
import {
  runProjectTransition,
  type ProjectTransitionHooks,
} from "./project-transition";

export type ScreenId = "home" | "editor" | "knowledge" | "glossary" | "comments" | "context" | "settings" | "community" | "account";
export type PageId = "welcome" | ScreenId;
export type IconName =
  | "folder"
  | "folderOpen"
  | "library"
  | "book"
  | "sidebar"
  | "panel"
  | "gear"
  | "chev"
  | "doc"
  | "plus"
  | "folderPlus"
  | "image"
  | "comment"
  | "community";

export type MenuEntry = readonly [label: string, kbd: string, id: string, checked?: boolean] | null;
export type MenuGroup = readonly [title: string, items: readonly MenuEntry[], app?: boolean];

export type PaletteItem = { g: string; l: string; k: string; id: string };

export type SbNode = {
  h?: string;
  searchText?: string;
  id?: string;
  k?: ScreenId;
  ic?: IconName;
  lbl?: string;
  han?: boolean;
  kids?: SbNode[];
  cnt?: number;
  dot?: "ok" | "warn" | "draft";
  t?: string;
  docId?: string;
  contextFor?: string;
  canHaveChildren?: boolean;
};

export type ShellOptions = {
  page: PageId;
  extraEnabled?: string[];
  extraPalette?: PaletteItem[];
  selfTitle?: string;
  pageCmd?: (id: string) => boolean | Promise<boolean>;
  pageKeys?: (e: KeyboardEvent, meta: boolean) => void;
  projectTransition?: ProjectTransitionHooks;
  beforeNavigate?: () => boolean;
};

export const SCREEN_FILES: Record<ScreenId, string> = {
  home: "home.html",
  editor: "editor.html",
  knowledge: "knowledge.html",
  glossary: "glossary.html",
  comments: "comments.html",
  context: "context.html",
  settings: "settings.html",
  community: "community.html",
  account: "settings.html#account",
};

const PAGE_ICONS: Partial<Record<PageId, IconName>> = {
  settings: "gear",
  community: "community",
  knowledge: "library",
  glossary: "book",
  comments: "comment",
};

export const ICONS: Record<IconName, string> = {
  folder:
    '<path d="M13.33 13.33a1.33 1.33 0 0 0 1.33-1.33V5.33a1.33 1.33 0 0 0-1.33-1.33h-5.27a1.33 1.33 0 0 1-1.13-.6L6.4 2.6A1.33 1.33 0 0 0 5.29 2H2.67a1.33 1.33 0 0 0-1.33 1.33v8.67a1.33 1.33 0 0 0 1.33 1.33Z"/>',
  folderOpen:
    '<path d="m4 9.33 1-1.93a1.33 1.33 0 0 1 1.16-.73h7.17a1.33 1.33 0 0 1 1.29 1.67l-1.03 4a1.33 1.33 0 0 1-1.3 1H2.67a1.33 1.33 0 0 1-1.34-1.34V3.33A1.33 1.33 0 0 1 2.67 2h2.6a1.33 1.33 0 0 1 1.12.6l.54.8a1.33 1.33 0 0 0 1.12.6H12a1.33 1.33 0 0 1 1.33 1.33v1.34"/>',
  library:
    '<path d="m10.67 4 2.67 9.33"/><path d="M8 4v9.33"/><path d="M5.33 5.33v8"/><path d="M2.67 2.67v10.67"/>',
  book:
    '<path d="M8 3.33v10.67"/><path d="M13.33 12.67A1.33 1.33 0 0 0 14.67 11.33V3.33a1.33 1.33 0 0 0-1.33-1.33L10.67 2A3.33 3.33 0 0 0 8 3.33a3.33 3.33 0 0 0-2.67-1.33H2.67a1.33 1.33 0 0 0-1.33 1.33v8a1.33 1.33 0 0 0 1.33 1.33H5.33a3.33 3.33 0 0 1 2.67 1.33 3.33 3.33 0 0 1 2.67-1.33z"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.2v1.2M8 12.6v1.2M2.2 8h1.2M12.6 8h1.2M3.9 3.9l.9.9M11.2 11.2l.9.9M12.1 3.9l-.9.9M4.8 11.2l-.9.9"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  doc:
    '<path d="M4 14.67a1.33 1.33 0 0 1-1.33-1.33V2.67a1.33 1.33 0 0 1 1.33-1.33h5.33a1.6 1.6 0 0 1 1.14 .47l2.39 2.39A1.6 1.6 0 0 1 13.33 5.33v8a1.33 1.33 0 0 1-1.33 1.33z"/><path d="M9.33 1.33v3.33a.67 .67 0 0 0 .67 .67h3.33"/><path d="M6.67 6H5.33"/><path d="M10.67 8.67H5.33"/><path d="M10.67 11.33H5.33"/>',
  plus: '<path d="M3.33 8h9.33"/><path d="M8 3.33v9.33"/>',
  // Reuses the tree's folder outline, so it reads as the same folder with a plus.
  folderPlus:
    '<path d="M13.33 13.33a1.33 1.33 0 0 0 1.33-1.33V5.33a1.33 1.33 0 0 0-1.33-1.33h-5.27a1.33 1.33 0 0 1-1.13-.6L6.4 2.6A1.33 1.33 0 0 0 5.29 2H2.67a1.33 1.33 0 0 0-1.33 1.33v8.67a1.33 1.33 0 0 0 1.33 1.33Z"/><path d="M8 6.67v4"/><path d="M6 8.67h4"/>',
  image:
    '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m2.5 11.5 3.5-3.5 3 3 2-2 2.5 2.5"/><circle cx="10.5" cy="6" r="1"/>',
  community:
    '<path d="M10.67 14v-1.33a2.67 2.67 0 0 0-2.67-2.67H4a2.67 2.67 0 0 0-2.67 2.67v1.33"/><path d="M10.67 2.09a2.67 2.67 0 0 1 0 5.16"/><path d="M14.67 14v-1.33a2.67 2.67 0 0 0-2-2.58"/><circle cx="6" cy="4.67" r="2.67"/>',
  comment:
    '<path d="M14.67 11.33a1.33 1.33 0 0 1-1.33 1.33H4.55a1.33 1.33 0 0 0-.94 .39l-1.47 1.47A.47 .47 0 0 1 1.33 14.19V3.33a1.33 1.33 0 0 1 1.33-1.33h10.67a1.33 1.33 0 0 1 1.33 1.33z"/>',
};

const GLOBAL_ENABLED = [
  "about",
  "updates",
  "prefs",
  "ai",
  "quit",
  "newproj",
  "open",
  "projects",
  "newdoc",
  "newfolder",
  "import",
  "close",
  "undo",
  "redo",
  "x",
  "c",
  "v",
  "find",
  "sidebar",
  "palette",
  "home",
  "editor",
  "prepare",
  "knowledge",
  "glossary",
  "comments",
  "min",
  "zoom",
  "self",
  "help",
  "seeddemo",
  "backup",
  "export",
] as const;

const PALETTE_SKIP = new Set(["self", "x", "c", "v", "undo", "redo", "quit", "min", "zoom", "palette"]);
const PROJECT_COMMANDS = new Set(["projects", "close", "newdoc", "newfolder", "import", "backup", "export", "find", "prepare", "home", "editor", "knowledge", "glossary", "comments"]);

const DOC_KEY = "munhae.doc";
const SB_KEY = "munhae.sb";
const SB_WIDTH_KEY = "munhae.sb.width";

let currentPage: PageId = "welcome";
let activeProject: ProjectSummary | null = null;
let projectChanges: ReturnType<typeof initProjectChanges> | undefined;
let mcpChanges: ReturnType<typeof initMcpChanges> | undefined;
export function registerProjectRefresh(refresh: ProjectRefresh): void { projectChanges?.register(refresh); mcpChanges?.register(refresh); }
let selfTitle = t("시작 화면");
let enabled = new Set<string>(GLOBAL_ENABLED);
let extraPalette: PaletteItem[] = [];
let pageCmd: ShellOptions["pageCmd"];
let pageKeys: ShellOptions["pageKeys"];
let projectTransition: ProjectTransitionHooks = {};
let beforeNavigate: ShellOptions["beforeNavigate"];
let refreshSidebarChrome: (() => void) | undefined;
let palSel = 0;
let palItems: PaletteItem[] = [];
let lastAgents: AgentProbe[] = [];
let preferredAgentId: AppConfig["agentId"] | null = null;
let appVersion = "0.1.0";
const sidebarNavigation = new SidebarNavigation();
const expanded = sidebarNavigation.expanded;
let sidebarTree: SbNode[] = [];
let sidebarRevealed: string | null = null;
let sidebarDocs: DocumentListItem[] = [];
let sidebarCurrentDoc: string | null = null;
let sidebarOnDoc: ((id: string, label: string) => void) | null = null;
let fallbackApi: MunhaeApi | null = null;

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export function $<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector(sel);
}

export function $$<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll(sel)] as T[];
}

export function must<T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = $<T>(sel, root);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
}

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"]/g, (c) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
    return map[c] ?? c;
  });
}

export function ic(name: IconName): string {
  return `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

export function requireApi(): MunhaeApi {
  if (window.munhae) return window.munhae;
  fallbackApi ??= createBrowserApi();
  return fallbackApi;
}

export function notify(msg: string, title = t("문해"), action?: { label: string; run(): void }): void {
  const n = $("#notif");
  const titleEl = $("#nTitle");
  const m = $("#nMsg");
  if (!n || !titleEl || !m) return;
  titleEl.textContent = t(title);
  m.textContent = t(msg);
  const holder = n as HTMLElement & { _h?: number; _action?: HTMLButtonElement };
  // Most notices carry no action; the button is made on first use and hidden again after.
  if (action && !holder._action) {
    holder._action = document.createElement("button");
    holder._action.type = "button";
    holder._action.className = "btn btn-sm notif-action";
    n.append(holder._action);
  }
  if (holder._action) {
    holder._action.hidden = !action;
    holder._action.textContent = action?.label ?? "";
    holder._action.onclick = action ? () => { n.classList.remove("show"); action.run(); } : null;
    if (action) n.classList.add("has-action"); else n.classList.remove("has-action");
  }
  n.classList.add("show");
  if (holder._h) window.clearTimeout(holder._h);
  // An offered action stays long enough to reach it.
  holder._h = window.setTimeout(() => n.classList.remove("show"), action ? 8000 : 3400);
}

export function unwrap<T>(result: IpcResult<T>, title = t("문해")): T | null {
  if (result.ok) return result.data;
  notify(result.error.message, title);
  return null;
}

export function persistDoc(id: string): void {
  store.set(activeProject ? projectDocumentKey(activeProject) : DOC_KEY, id);
}

export function readPersistedDoc(): string | null {
  return currentDocId();
}

export function currentDocId(): string | null {
  return new URLSearchParams(location.search).get("doc")
    ?? store.get(activeProject ? projectDocumentKey(activeProject) : DOC_KEY)
    ?? (activeProject?.storageMode === "local" ? store.get(DOC_KEY) : null);
}

export function go(k: ScreenId, docId?: string): void {
  if (k === currentPage && !docId) return;
  if (k === "context" && currentPage === "context" && docId === new URLSearchParams(location.search).get("node")) return;
  if (beforeNavigate && !beforeNavigate()) return;
  if (k === "context") {
    location.href = docId ? `context.html?node=${encodeURIComponent(docId)}` : "context.html";
    return;
  }
  const doc = docId ?? (k === "editor" ? currentDocId() : null);
  if (doc) persistDoc(doc);
  if (k === "editor") {
    location.href = doc ? `${SCREEN_FILES[k]}?doc=${encodeURIComponent(doc)}` : SCREEN_FILES[k];
    return;
  }
  location.href = SCREEN_FILES[k];
}

const OPEN_TERM_KEY = "munhae.open-term";

/** Opens a document's term screen with one project term selected. */
export function openDocumentTerm(documentId: string, termId: string): void {
  store.set(OPEN_TERM_KEY, JSON.stringify({ documentId, termId }));
  go("editor", documentId);
}

/** The term handed over by openDocumentTerm. It is read once. */
export function takeDocumentTerm(): { documentId: string; termId: string } | null {
  const raw = store.get(OPEN_TERM_KEY);
  if (!raw) return null;
  store.set(OPEN_TERM_KEY, "");
  try {
    const value = JSON.parse(raw) as { documentId?: unknown; termId?: unknown };
    return typeof value.documentId === "string" && typeof value.termId === "string" ? { documentId: value.documentId, termId: value.termId } : null;
  } catch {
    return null;
  }
}

export async function requireProject(): Promise<ProjectSummary | null> {
  const api = requireApi();
  const current = await api.project.getCurrent();
  if (!current) {
    location.href = "index.html";
    return null;
  }
  if (current.storageMode === "online") {
    const account = await api.auth.getState();
    if (!account.ok || account.data.status !== "signed_in" || account.data.user?.id !== current.accountId) {
      location.replace("index.html");
      return null;
    }
  }
  setSidebarProject(current);
  return current;
}

export function setSidebarProject(project: ProjectSummary): void {
  activeProject = project;
  sidebarNavigation.setProject(project);
  refreshSidebarChrome?.();
}

export { projectLocationLabel };
export function savedLocallyLabel(): string {
  return activeProject?.storageMode === "online" ? t("온라인 저장됨") : t("저장됨");
}

export function findDefaultDoc(docs: DocumentListItem[]): string | null {
  const hunmin = docs.find(
    (d) =>
      d.nodeRole === "source_unit" &&
      (d.title.includes("御製序") || (d.originalTitle?.includes("御製序") ?? false)),
  );
  if (hunmin) return hunmin.id;
  const withSource = docs.find((d) => d.nodeRole === "source_unit");
  return withSource?.id ?? docs[0]?.id ?? null;
}

export function shortPath(p: string): string {
  const m = p.match(/^\/Users\/[^/]+/);
  if (m?.[0]) return `~${p.slice(m[0].length)}`;
  return p;
}

export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function fmtClock(d = new Date()): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function nowHM(): string {
  return new Date().toTimeString().slice(0, 5);
}

export function stateLabel(
  kind: "source" | "punctuation" | "translation",
  state: VersionUiState,
): string | null {
  if (state === "none") return null;
  if (state === "confirmed") return t("확정");
  if (state === "review") return t("재검토 필요");
  if (kind === "source") return t("원문안");
  if (kind === "punctuation") return t("표점안");
  return t("번역안");
}

export function tagHtml(label: string | null, extra = ""): string {
  if (!label) return '<span class="muted">—</span>';
  const cls =
    label === "확정"
      ? "tag-ok"
      : label === "재검토 필요" || label === "preflight"
        ? "tag-warn"
        : label === "번역안" || label === "원문안" || label === "표점안"
          ? "tag-draft"
          : "tag-plain";
  const tail = extra ? ` <span class="mono muted" style="font-size:11px">${esc(extra)}</span>` : "";
  return `<span class="tag ${cls}">${esc(label)}</span>${tail}`;
}

export function rowStatus(d: DocumentListItem): "draft" | "review" | "confirmed" | "none" | "progress" {
  if (d.translationState === "confirmed") return "confirmed";
  if (d.translationState === "review") return "review";
  if (d.sourceState === "none") return "none";
  if (d.translationState === "draft" || d.punctuationState === "draft" || d.sourceState === "draft") {
    return d.translationState === "draft" ? "draft" : "progress";
  }
  return "progress";
}



export function agentSummary(
  agents: AgentProbe[],
  preferred?: AppConfig["agentId"] | null,
): { text: string; cls: "ok" | "warn" | "" } {
  const claude = agents.find((a) => a.agentId === "claude");
  const codex = agents.find((a) => a.agentId === "codex");
  const selected = preferred ? agents.find((agent) => agent.agentId === preferred) : undefined;
  if (selected) {
    const name = selected.agentId === "antigravity" ? "Antigravity CLI" : selected.agentId === "claude" ? "Claude CLI" : "Codex CLI";
    if (selected.installed && selected.loggedIn) return { text: name, cls: "ok" };
    if (selected.installed && selected.loggedIn === false) return { text: ui`${name} · 로그인 필요`, cls: "warn" };
    if (selected.installed) return { text: ui`${name} · 설치됨`, cls: "" };
    return { text: ui`${name} 미설치`, cls: "warn" };
  }
  if (claude?.installed && claude.loggedIn) return { text: "Claude CLI", cls: "ok" };
  if (codex?.installed && codex.loggedIn) return { text: "Codex CLI", cls: "ok" };
  if (claude?.installed) return { text: t("Claude CLI · 로그인 필요"), cls: "warn" };
  if (codex?.installed) return { text: t("Codex CLI · 로그인 필요"), cls: "warn" };
  if (claude && !claude.installed) return { text: t("Claude CLI 미설치"), cls: "warn" };
  return { text: t("AI 미연결"), cls: "" };
}

export function formatAgentDetail(agents: AgentProbe[]): string {
  if (!agents.length) return t("에이전트를 확인할 수 없습니다");
  return agents
    .map((a) => {
      const name = a.agentId === "antigravity" ? "Antigravity CLI" : a.agentId === "claude" ? "Claude CLI" : "Codex CLI";
      if (!a.installed) return ui`${name} 미설치`;
      if (a.loggedIn) return ui`${name} 로그인됨${a.version ? ` · ${a.version}` : ""}`;
      if (a.loggedIn === false) return ui`${name} 설치됨, 로그인 필요`;
      return ui`${name} 설치됨`;
    })
    .join(" · ");
}

export function setAgentChrome(
  agents: AgentProbe[],
  version?: string,
  preferred?: AppConfig["agentId"] | null,
): void {
  lastAgents = agents;
  if (preferred !== undefined) preferredAgentId = preferred;
  if (version) appVersion = version;
  const sum = agentSummary(agents, preferredAgentId);
  $$(".statusbar .dot").forEach((dot) => {
    const span = dot.parentElement;
    if (!span || span.id) return;
    if (span.textContent?.includes("CLI") || span.textContent?.includes("AI")) {
      span.innerHTML = `<i class="dot ${sum.cls}"></i>${esc(sum.text)}`;
    }
  });
  const sbAgent = $("#sbAgent");
  if (sbAgent) sbAgent.innerHTML = `<i class="dot ${sum.cls}"></i>${esc(sum.text)}`;
}

function commandGroups(): MenuGroup[] {
  return [
    [
      t("문해"),
      [
        [t("문해 정보"), "", "about"],
        null,
        [t("설정…"), "⌘,", "prefs"],
        [t("AI 연결 상태…"), "", "ai"],
        null,
        [t("문해 종료"), "⌘Q", "quit"],
      ],
      true,
    ],
    [
      t("파일"),
      [
        [t("새 프로젝트…"), "⇧⌘N", "newproj"],
        [t("프로젝트 열기…"), "⌘O", "open"],
        null,
        [t("새 문서"), "⌘N", "newdoc"],
        [t("새 폴더"), "", "newfolder"],
        [t("원문 가져오기…"), "", "import"],
        null,
        [t("백업 만들기…"), "", "backup"],
        [t("내보내기…"), "⌘E", "export"],
        null,
        [t("프로젝트 닫기"), "⌘W", "close"],
      ],
    ],
    [
      t("편집"),
      [
        [t("실행 취소"), "⌘Z", "undo"],
        [t("다시 실행"), "⇧⌘Z", "redo"],
        null,
        [t("잘라내기"), "⌘X", "x"],
        [t("복사"), "⌘C", "c"],
        [t("붙여넣기"), "⌘V", "v"],
        null,
        [t("찾기…"), "⌘F", "find"],
      ],
    ],
    [
      t("보기"),
      [
        [t("사이드바 보기/가리기"), "⌃⌘S", "sidebar"],
        [t("참고 자료 패널"), "⌥⌘R", "refpane"],
        [currentPage === "editor" ? t("참고 자료·AI 패널") : t("검사기 패널"), "⌥⌘I", "ctxpane"],
        null,
        [t("표점 전문"), "⌘1", "v-source"],
        [t("대조"), "⌘2", "v-parallel"],
        [t("번역 전문"), "⌘3", "v-full"],
        null,
        [t("구조 표시"), "", "struct"],
      ],
    ],
    [
      t("번역"),
      [
        [t("AI 번역…"), "⌥⌘K", "prepare"],
        null,
        [t("다음 블록과 합치기"), "⌥⌘M", "merge"],
        [t("블록 나누기…"), "⌥⌘S", "split"],
        [t("앵커 연결…"), "⌥⌘L", "link"],
        null,
        [t("변경 비교"), "⌘D", "diff"],
        [t("번역안 확정"), "⇧⌘↩", "confirm"],
      ],
    ],
    [
      t("이동"),
      [
        [t("프로젝트 홈"), "⇧⌘1", "home"],
        [t("편집"), "⇧⌘2", "editor"],
        [t("문맥"), "⇧⌘3", "knowledge"],
        [t("용어집"), "", "glossary"],
        [t("코멘트"), "", "comments"],
        null,
        [t("명령 검색…"), "⌘K", "palette"],
      ],
    ],
    [
      t("창"),
      [
        [t("최소화"), "⌘M", "min"],
        [t("확대/축소"), "", "zoom"],
        null,
        [selfTitle, "", "self", true],
      ],
    ],
    [
      t("도움말"),
      [
        [t("문해 도움말"), "", "help"],
        [t("업데이트 확인…"), "", "updates"],
      ],
    ],
  ];
}

function paletteItems(q: string): PaletteItem[] {
  const out: PaletteItem[] = [...extraPalette];
  for (const [t, items] of commandGroups()) {
    for (const it of items) {
      if (it && enabled.has(it[2]) && !PALETTE_SKIP.has(it[2]) && (!PROJECT_COMMANDS.has(it[2]) || activeProject)) {
        out.push({ g: t, l: it[0], k: it[1], id: it[2] });
      }
    }
  }
  if (!q) return out;
  const n = q.toLowerCase();
  return out.filter((o) => (o.l + o.g).toLowerCase().includes(n));
}

function renderPalette(): void {
  const palIn = $("#palIn") as HTMLInputElement | null;
  const palList = $("#palList");
  if (!palIn || !palList) return;
  palItems = paletteItems(palIn.value.trim());
  palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
  let g = "";
  palList.innerHTML =
    palItems
      .map((o, i) => {
        const h =
          (o.g !== g ? `<div class="pl-h">${esc(o.g)}</div>` : "") +
          `<button class="pl-item${i === palSel ? " is-sel" : ""}" data-i="${i}" type="button">${esc(o.l)}<kbd>${esc(o.k)}</kbd></button>`;
        g = o.g;
        return h;
      })
      .join("") || uiText('<div class="pl-h">일치하는 명령이 없습니다</div>');
  const el = palList.querySelector(".is-sel");
  if (el instanceof HTMLElement) {
    const t = el.offsetTop - palList.offsetTop;
    const b = t + el.offsetHeight;
    if (t < palList.scrollTop) palList.scrollTop = t - 6;
    else if (b > palList.scrollTop + palList.clientHeight) palList.scrollTop = b - palList.clientHeight + 6;
  }
}

export function openPalette(): void {
  const pal = $("#dlgPalette") as HTMLDialogElement | null;
  const palIn = $("#palIn") as HTMLInputElement | null;
  if (!pal || !palIn) return;
  palIn.value = "";
  palSel = 0;
  renderPalette();
  pal.showModal();
  palIn.focus();
}

export function toggleSidebar(force?: boolean): void {
  const w = $("#win");
  const btn = $("#tbSidebar");
  if (!w) {
    notify(t("시작 화면에는 사이드바가 없습니다. 프로젝트를 열면 ⌃⌘S로 접을 수 있습니다"), t("보기"));
    return;
  }
  const hide = force !== undefined ? force : !w.classList.contains("sb-hidden");
  w.classList.toggle("sb-hidden", hide);
  store.set(SB_KEY, hide ? "0" : "1");
  btn?.classList.toggle("is-on", !hide);
}

function initSidebarResize(): void {
  const win = $("#win");
  const sidebar = $("#sidebar");
  if (!win || !sidebar || $("#sbResizer")) return;
  const defaultWidth = 220;
  const minWidth = 220;
  // AuthGate hides the shell during page initialization, making clientWidth zero.
  // The shell fills the viewport; use that width until it becomes measurable.
  const maxWidth = (): number => Math.max(minWidth, Math.min(480, (win.clientWidth || document.documentElement.clientWidth) - 720));
  const savedWidth = Number(store.get(SB_WIDTH_KEY));
  let preferredWidth = Number.isFinite(savedWidth) && savedWidth >= minWidth ? Math.min(480, savedWidth) : defaultWidth;
  let width = preferredWidth;
  let drag: { pointerId: number; startX: number; startWidth: number } | null = null;
  const handle = document.createElement("div");
  handle.id = "sbResizer";
  handle.className = "sb-resizer";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", t("사이드바 너비"));
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-controls", "sidebar");
  handle.title = t("드래그하여 너비 조절 · 두 번 클릭하면 기본 너비");
  sidebar.append(handle);

  const applyWidth = (next: number): void => {
    width = Math.round(Math.max(minWidth, Math.min(maxWidth(), next)));
    win.style.setProperty("--sbw", `${width}px`);
    handle.setAttribute("aria-valuemin", String(minWidth));
    handle.setAttribute("aria-valuemax", String(maxWidth()));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", ui`${width}픽셀`);
  };
  const rememberWidth = (): void => {
    preferredWidth = width;
    store.set(SB_WIDTH_KEY, String(width));
  };
  const finishDrag = (cancel = false): void => {
    if (!drag) return;
    const pointerId = drag.pointerId;
    drag = null;
    if (cancel) applyWidth(preferredWidth);
    else rememberWidth();
    handle.classList.remove("is-drag");
    document.body.classList.remove("is-resizing-sidebar");
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width };
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("is-drag");
    document.body.classList.add("is-resizing-sidebar");
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.pointerId === event.pointerId) applyWidth(drag.startWidth + event.clientX - drag.startX);
  });
  handle.addEventListener("pointerup", (event) => { if (drag?.pointerId === event.pointerId) finishDrag(); });
  handle.addEventListener("pointercancel", (event) => { if (drag?.pointerId === event.pointerId) finishDrag(true); });
  handle.addEventListener("lostpointercapture", () => finishDrag(true));
  handle.addEventListener("dblclick", () => { applyWidth(defaultWidth); rememberWidth(); });
  handle.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      finishDrag(true);
      return;
    }
    if (drag || event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? 40 : 10;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: minWidth, End: maxWidth() }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    applyWidth(next);
    rememberWidth();
  });
  window.addEventListener("resize", () => { finishDrag(true); applyWidth(preferredWidth); });
  window.addEventListener("blur", () => finishDrag(true));
  applyWidth(preferredWidth);
}

export function toggleInsp(): void {
  const s = $("#split");
  const btn = $("#tbInsp");
  if (!s) return;
  s.classList.toggle("no-insp");
  btn?.classList.toggle("is-on", !s.classList.contains("no-insp"));
}

const LIBRARY_SCREENS = new Set<ScreenId>(["knowledge", "glossary", "comments"]);

function sbNode(n: SbNode, d: number, pos = 1, size = 1): string {
  if (n.h === t("문서")) {
    return ui`<div class="sb-h-row"><div class="sb-h">문서</div><div class="sb-create-actions" role="group" aria-label="항목 추가"><button class="sb-add" type="button" data-sb-command="newfolder" title="새 폴더" aria-label="새 폴더">${ic("folderPlus")}</button><button class="sb-add" type="button" data-sb-command="newdoc" title="새 문서" aria-label="새 문서">${ic("plus")}</button></div></div>`;
  }
  if (n.h) return `<div class="sb-h">${esc(n.h)}</div>`;
  const kids = !!n.kids?.length;
  const cur = n.contextFor
    ? currentPage === "context" && n.contextFor === sidebarCurrentDoc
    : n.k === "home"
      ? currentPage === "home" || (currentPage !== "context" && n.docId === sidebarCurrentDoc)
      : n.k
        ? n.k === currentPage && (!n.docId || n.docId === sidebarCurrentDoc)
        : n.docId
          ? currentPage !== "context" && n.docId === sidebarCurrentDoc
          : false;
  const isDocument = !!(n.docId || n.contextFor);
  const exp = isDocument && sidebarNavigation.query ? true : n.id ? expanded.get(n.id) !== false : true;
  const treeAttrs = isDocument ? ` role="treeitem" tabindex="-1" data-sb-key="${esc(n.id)}" aria-level="${d + 1}" aria-posinset="${pos}" aria-setsize="${size}" aria-selected="${cur}"${n.docId && n.k !== "home" ? ' draggable="true"' : ""}` : "";
  const parts: string[] = [];
  const rowClass = n.contextFor ? " sb-context" : n.k && LIBRARY_SCREENS.has(n.k) ? " sb-library" : "";
  parts.push(`<div class="sb-row${rowClass}"${isDocument ? ' role="none"' : ""}>`);
  parts.push(
    `<button class="sb-item${cur ? " is-current" : ""}" type="button"${treeAttrs} data-depth="${d}" style="--sb-depth:${d}"${kids && n.id ? ` aria-expanded="${exp}"` : ""}${n.k ? ` data-go="${n.k}"` : ""}${n.docId ? ` data-doc-id="${esc(n.docId)}"` : ""}${n.contextFor ? ` data-context-for="${esc(n.contextFor)}"` : ""}${n.t ? ` title="${esc(n.t)}"` : ""}${cur ? ' aria-current="page"' : ""}>`,
  );
  if (kids && n.id) {
    parts.push(
      `<svg class="ic chev" viewBox="0 0 16 16" data-exp="${esc(n.id)}" aria-hidden="true">${ICONS.chev}</svg>`,
    );
  }
  if (n.ic) parts.push(ic(n.ic));
  parts.push(`<span class="lbl${n.han ? " hanmun" : ""}">${esc(n.lbl ?? "")}</span>`);
  if (n.cnt) parts.push(`<span class="cnt">${n.cnt}</span>`);
  if (n.dot) {
    const status = t({ ok: "번역: 확정", warn: "번역: 검토 중", draft: "번역: 초안" }[n.dot]);
    parts.push(`<i class="dot ${n.dot}" role="img" aria-label="${esc(status)}" title="${esc(status)}"></i>`);
  }
  parts.push("</button>");
  if (n.docId) parts.push(`<button class="sb-more" type="button" tabindex="-1" data-sb-menu="${esc(n.docId)}" aria-label="${esc(n.lbl)} · ${esc(t("문서 메뉴"))}" aria-haspopup="menu" title="${esc(t("문서 메뉴"))}">⋯</button>`);
  parts.push("</div>");
  if (kids && exp && n.kids) {
    parts.push(`<div class="sb-children" style="--sb-depth:${d}"${isDocument ? ' role="none"' : ""}>`);
    parts.push(n.kids.map((k, i) => sbNode(k, d + 1, i + 1, n.kids!.length)).join(""));
    parts.push("</div>");
  }
  return parts.join("");
}

export function docsToTree(docs: DocumentListItem[]): SbNode[] {
  sidebarDocs = docs;
  const byParent = new Map<string | "root", DocumentListItem[]>();
  for (const d of docs) {
    const key = d.parentId ?? "root";
    const arr = byParent.get(key) ?? [];
    arr.push(d);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.ordinal - b.ordinal || a.title.localeCompare(b.title, "ko"));
  }
  const walk = (parent: string | "root"): SbNode[] => {
    return (byParent.get(parent) ?? []).map((d) => {
      const documentKids = walk(d.id);
      const isContainer = d.nodeRole === "container";
      const dot: SbNode["dot"] =
        d.translationState === "confirmed"
          ? "ok"
          : d.translationState === "review"
            ? "warn"
            : d.translationState === "draft"
              ? "draft"
              : undefined;
      if (!expanded.has(d.id)) expanded.set(d.id, d.depth < 1);
      return {
        id: d.id,
        docId: d.id,
        k: d.isMaster ? "home" : isContainer ? undefined : "editor",
        lbl: d.originalTitle || d.title,
        searchText: `${d.title} ${d.originalTitle ?? ""}`,
        han: true,
        ic: d.isMaster ? "folderOpen" : isContainer ? "folder" : "doc",
        kids: [
          {
            id: `context:${d.id}`,
            contextFor: d.id,
            lbl: t("문맥"),
            ic: "library",
            cnt: d.contextCount || undefined,
            t: ui`${d.originalTitle || d.title} · 직접 작성한 문맥과 상위에서 이어받은 문맥`,
          },
          ...documentKids,
        ],
        cnt: isContainer ? documentKids.length || undefined : undefined,
        dot,
        t: `${d.title} · ${d.isMaster ? t("프로젝트 홈") : isContainer ? t("목차 폴더") : t("원문 문서")}`,
        canHaveChildren: isContainer,
      };
    });
  };
  return walk("root");
}

export function defaultSidebarTree(docs: DocumentListItem[]): SbNode[] {
  return [
    { h: t("문서") },
    ...docsToTree(docs),
    { k: "knowledge", ic: "library", lbl: t("문맥") },
    { k: "glossary", ic: "book", lbl: t("용어집") },
    { k: "comments", ic: "comment", lbl: t("코멘트") },
    { k: "settings", ic: "gear", lbl: t("설정") },
    { k: "community", ic: "community", lbl: t("커뮤니티") },
  ];
}

export function renderSidebar(
  tree: SbNode[],
  opts?: { currentDocId?: string | null },
): void {
  const root = $("#sbTree");
  if (!root) return;
  sidebarTree = tree;
  sidebarNavigation.mount(root, () => renderSidebar(sidebarTree));
  sidebarNavigation.beforeRender();
  if (opts?.currentDocId !== undefined) sidebarCurrentDoc = opts.currentDocId;
  const activeKey = currentPage === "context" ? `context:${sidebarCurrentDoc}` : currentPage === "editor" ? sidebarCurrentDoc : null;
  let reveal = false;
  if (activeKey && activeKey !== sidebarRevealed) {
    const ancestors = sidebarAncestors(tree, activeKey);
    if (ancestors) {
      ancestors.forEach(id => expanded.set(id, true));
      sidebarRevealed = activeKey;
      reveal = true;
    }
  }
  const documents = filterSidebarBranches(tree.filter(n => n.docId), sidebarNavigation.query);
  let renderedDocuments = false;
  const documentMarkup = () => {
    renderedDocuments = true;
    return `<div id="sbDocuments" role="tree" aria-label="${esc(t("문서"))}">${documents.map((n, i) => sbNode(n, 0, i + 1, documents.length)).join("")}</div>`
      + (!documents.length && sidebarNavigation.query ? `<p class="sb-empty">${esc(t("일치하는 문서가 없습니다"))}</p>` : "");
  };
  const footer = $("#sidebar .sb-foot");
  const footerNodes = tree.filter(n => n.k === "settings" || n.k === "community");
  let footerNav = footer?.querySelector<HTMLElement>(".sb-footer-nav");
  if (footer && footerNodes.length) {
    if (!footerNav) {
      footerNav = document.createElement("div");
      footerNav.className = "sb-footer-nav";
      footer.prepend(footerNav);
    }
    footerNav.innerHTML = footerNodes.map(n => sbNode(n, 0)).join("");
    footerNav.querySelectorAll<HTMLButtonElement>(".sb-item[data-go]").forEach(button => button.addEventListener("click", () => go(button.dataset.go as ScreenId)));
  } else {
    footerNav?.remove();
  }
  // The library screens stay put above the footer while the document tree scrolls.
  const libraryNodes = footer ? tree.filter(n => !n.docId && n.k && LIBRARY_SCREENS.has(n.k)) : [];
  let libraryNav = footer?.parentElement?.querySelector<HTMLElement>(":scope > .sb-library-nav");
  if (footer && libraryNodes.length) {
    if (!libraryNav) {
      libraryNav = document.createElement("div");
      libraryNav.className = "sb-library-nav";
      footer.before(libraryNav);
    }
    libraryNav.innerHTML = libraryNodes.map(n => sbNode(n, 0)).join("");
    libraryNav.querySelectorAll<HTMLButtonElement>(".sb-item[data-go]").forEach(button => button.addEventListener("click", () => go(button.dataset.go as ScreenId)));
  } else {
    libraryNav?.remove();
  }
  const elsewhere = (n: SbNode) => !!n.docId || (!!footer && footerNodes.includes(n)) || libraryNodes.includes(n);
  root.innerHTML = tree.map(n => elsewhere(n) ? "" : sbNode(n, 0) + (n.h === t("문서") ? documentMarkup() : "")).join("");
  if (!renderedDocuments) root.insertAdjacentHTML("beforeend", documentMarkup());
  sidebarNavigation.afterRender(reveal);
  refreshSidebarChrome?.();
}

export function revealSidebarNode(docs: DocumentListItem[], nodeId: string): void {
  const byId = new Map(docs.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let node = byId.get(nodeId);
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    expanded.set(node.id, true);
    node = node.parentId ? byId.get(node.parentId) : undefined;
  }
}

let sidebarOnNew: ((parentId: string | null, role: DocumentNodeRole) => void) | null = null;

export async function openDocumentDialog(parentId: string | null = null, importText = false, role: DocumentNodeRole = "source_unit"): Promise<void> {
  const { openNewDocument } = await import("./new-document-dialog");
  await openNewDocument(parentId, role, importText);
}

export function bindSidebar(
  onDoc?: (id: string, label: string) => void,
  treeFn?: () => SbNode[],
  onNew?: (parentId: string | null, role: DocumentNodeRole) => void,
  options?: { selectExpandable?: boolean },
): void {
  sidebarOnDoc = onDoc ?? null;
  sidebarOnNew =
    onNew ??
    ((parentId, role) => { void openDocumentDialog(parentId, false, role); });
  const root = $("#sbTree");
  if (!root || root.dataset.bound === "1") return;
  bindSidebarActions(root, {
    api: requireApi(), docs: () => sidebarDocs, escape: esc,
    create: (parentId, role) => sidebarOnNew?.(parentId, role),
    context: id => go("context", id),
    info: id => {
      if (beforeNavigate && !beforeNavigate()) return;
      location.href = `knowledge.html?node=${encodeURIComponent(id)}&info=1`;
    },
    mutate: async (action, removed) => {
      const transition = await runProjectTransition("organize", projectTransition, action, result => result.ok);
      if (!transition.started) return false;
      if (!transition.result.ok) throw new Error(transition.result.error.message);
      // Refresh inherited metadata, context and preparation as well as the tree.
      // Leave hooks commit only after a successful write, preserving drafts on error.
      const params = new URLSearchParams(location.search);
      const shown = [params.get("doc"), params.get("node"), currentPage === "editor" ? currentDocId() : null];
      if (removed?.some(id => shown.includes(id))) location.href = SCREEN_FILES.home;
      else location.reload();
      return true;
    },
    error: message => notify(message, t("문서")),
    reveal: id => revealSidebarNode(sidebarDocs, id),
  });
  root.dataset.bound = "1";
  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const exp = target.closest("[data-exp]");
    if (exp instanceof SVGElement && root.contains(exp) && exp.dataset.exp) {
      e.preventDefault();
      e.stopPropagation();
      const id = exp.dataset.exp;
      if (!sidebarNavigation.query) expanded.set(id, expanded.get(id) === false);
      if (treeFn) renderSidebar(treeFn(), { currentDocId: sidebarCurrentDoc });
      return;
    }
    const b = target.closest(".sb-item");
    if (!(b instanceof HTMLElement)) return;
    if (b.dataset.contextFor) {
      go("context", b.dataset.contextFor);
      return;
    }
    if (b.dataset.go === "home" && b.dataset.docId && options?.selectExpandable) {
      // Pages that select folders in place keep the project root selectable.
      sidebarOnDoc?.(b.dataset.docId, b.textContent ?? "");
      return;
    }
    if (b.hasAttribute("aria-expanded") && b.dataset.docId && !b.dataset.go) {
      e.preventDefault();
      const id = b.dataset.docId;
      if (!sidebarNavigation.query) expanded.set(id, expanded.get(id) === false);
      if (treeFn) renderSidebar(treeFn(), { currentDocId: sidebarCurrentDoc });
      if (options?.selectExpandable) sidebarOnDoc?.(id, b.textContent ?? "");
      return;
    }
    if (b.dataset.go) {
      const k = b.dataset.go as ScreenId;
      const docId = k === "home" ? undefined : b.dataset.docId;
      if (k === "editor" && currentPage === "editor" && docId && sidebarOnDoc) {
        sidebarOnDoc(docId, b.textContent ?? "");
        return;
      }
      go(k, docId);
      return;
    }
    if (b.dataset.docId) {
      sidebarOnDoc?.(b.dataset.docId, b.textContent ?? "");
    }
  });
}

export function setSelfTitle(title: string): void {
  selfTitle = title;
}

function ensureDialog(id: string, html: string): HTMLDialogElement {
  let el = document.getElementById(id) as HTMLDialogElement | null;
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", html);
    el = document.getElementById(id) as HTMLDialogElement | null;
  }
  if (!el) throw new Error(`dialog ${id}`);
  return el;
}

function ensureSharedDialogs(): void {
  ensureDialog(
    "dlgNewProj",
    uiText(`<dialog id="dlgNewProj">
      <form method="dialog" id="newProjForm">
        <div class="dl-h">새 프로젝트</div>
        <div class="dl-b">
          <div class="field"><label for="npTitle">제목</label><input class="input" id="npTitle" required placeholder="예: 훈민정음 문헌 번역"></div>
          <p class="muted" style="font-size:12px">폴더를 고르면 .munhae 프로젝트가 만들어집니다. 서버로 전송하지 않습니다.</p>
        </div>
        <div class="dl-f"><button class="btn" type="button" id="npCancel">취소</button><button class="btn btn-primary" type="submit">만들기</button></div>
      </form>
    </dialog>`),
  );
  ensureDialog(
    "dlgPrefs",
    uiText(`<dialog id="dlgPrefs" style="width:min(760px,calc(100vw - 48px));margin-top:48px">
      <form method="dialog" id="prefsForm">
        <div class="dl-h">설정</div>
        <div class="dl-b" style="max-height:calc(100vh - 170px);overflow:auto">
          <div class="field"><label for="prefAgent">기본 에이전트</label>
            <select class="select" id="prefAgent"><option value="claude">Claude CLI</option><option value="codex">Codex CLI</option></select>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px">
            <section style="border:1px solid var(--border);border-radius:8px;padding:12px;display:grid;gap:10px" aria-labelledby="prefCodexHeading">
              <div class="row"><b id="prefCodexHeading">Codex CLI</b><span class="sp"></span><button class="btn btn-sm" type="button" data-pref-login-agent="codex">로그인 안내</button></div>
              <div class="field"><label for="prefCodexModel">모델</label><select class="select mono" id="prefCodexModel"><option value="default">CLI 기본값</option></select></div>
              <div class="field"><label for="prefCodexReasoning">Reasoning effort</label><select class="select" id="prefCodexReasoning"><option value="">CLI 기본값</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></div>
              <div class="field"><label for="prefCodexTier">Service tier</label><select class="select" id="prefCodexTier"><option value="">CLI 기본값</option><option value="auto">auto</option><option value="default">default</option><option value="flex">flex</option><option value="priority">priority</option></select></div>
              <code id="prefCodexLogin" class="mono" style="display:none;padding:8px;border-radius:5px;background:var(--chrome);overflow-wrap:anywhere;user-select:text"></code>
              <p id="prefCodexLoginDetail" class="muted" style="display:none;margin:0;font-size:11px"></p>
              <p id="prefCodexProbe" class="muted" style="margin:0;font-size:11px">CLI 상태와 지원 모델을 확인하지 않았습니다.</p>
            </section>
            <section style="border:1px solid var(--border);border-radius:8px;padding:12px;display:grid;gap:10px" aria-labelledby="prefClaudeHeading">
              <div class="row"><b id="prefClaudeHeading">Claude CLI</b><span class="sp"></span><button class="btn btn-sm" type="button" data-pref-login-agent="claude">로그인 안내</button></div>
              <div class="field"><label for="prefClaudeModel">모델</label><select class="select mono" id="prefClaudeModel"><option value="default">CLI 기본값</option></select></div>
              <div class="field"><label for="prefClaudeReasoning">Reasoning effort</label><select class="select" id="prefClaudeReasoning"><option value="">CLI 기본값</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></div>
              <div class="field"><label for="prefClaudeTier">Service tier</label><select class="select" id="prefClaudeTier" disabled><option value="">지원하지 않음</option></select></div>
              <code id="prefClaudeLogin" class="mono" style="display:none;padding:8px;border-radius:5px;background:var(--chrome);overflow-wrap:anywhere;user-select:text"></code>
              <p id="prefClaudeLoginDetail" class="muted" style="display:none;margin:0;font-size:11px"></p>
              <p id="prefClaudeProbe" class="muted" style="margin:0;font-size:11px">CLI 상태와 지원 모델을 확인하지 않았습니다.</p>
            </section>
          </div>
          <label class="check"><input type="checkbox" id="prefWelcome"> 실행할 때 시작 창 표시</label>
          <p class="muted" style="font-size:12px">agent · model · reasoning · service tier는 프로젝트 밖 app-config.json에 저장됩니다. 로그인은 각 공급자의 공식 CLI가 대화형 터미널에서 처리하며 문해는 토큰을 저장하지 않습니다.</p>
        </div>
        <div class="dl-f"><button class="btn" type="button" id="prefCancel">취소</button><button class="btn btn-primary" type="submit">저장</button></div>
      </form>
    </dialog>`),
  );
  const npCancel = $("#npCancel");
  if (npCancel && !npCancel.dataset.bound) {
    npCancel.dataset.bound = "1";
    npCancel.addEventListener("click", () => ($("#dlgNewProj") as HTMLDialogElement).close());
    must<HTMLFormElement>("#newProjForm").addEventListener("submit", (e) => {
      e.preventDefault();
      void submitNewProject();
    });
  }
  const prefCancel = $("#prefCancel");
  if (prefCancel && !prefCancel.dataset.bound) {
    prefCancel.dataset.bound = "1";
    prefCancel.addEventListener("click", () => ($("#dlgPrefs") as HTMLDialogElement).close());
    must<HTMLFormElement>("#prefsForm").addEventListener("submit", (e) => {
      e.preventDefault();
      void submitPrefs();
    });
    for (const button of $$<HTMLButtonElement>("[data-pref-login-agent]")) {
      button.addEventListener("click", () => void showLoginInstruction(button));
    }
    for (const agentId of ["codex", "claude"] as const) {
      const prefix = preferencePrefix(agentId);
      must<HTMLSelectElement>(`#pref${prefix}Model`).addEventListener("change", () => {
        populatePreferenceCapabilities(
          agentId,
          must<HTMLSelectElement>(`#pref${prefix}Model`).value,
          null,
          null,
        );
      });
    }
  }
}

function preferencePrefix(agentId: AppConfig["agentId"]): "Codex" | "Claude" {
  return agentId === "codex" ? "Codex" : "Claude";
}

function replacePreferenceOptions(
  select: HTMLSelectElement,
  options: ReadonlyArray<{ id: string; label: string }>,
  selected: string | null,
  emptyLabel: string,
): void {
  const values = [{ id: "", label: emptyLabel }, ...options.filter((option) => option.id)];
  if (selected && !values.some((option) => option.id === selected)) {
    values.push({ id: selected, label: ui`${selected} · 저장된 값` });
  }
  select.replaceChildren(...values.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  select.value = selected ?? "";
}

function populatePreferenceCapabilities(
  agentId: AppConfig["agentId"],
  modelId: string,
  reasoning: string | null,
  serviceTier: string | null,
): void {
  const prefix = preferencePrefix(agentId);
  const probe = lastAgents.find((item) => item.agentId === agentId);
  const model = probe?.models.find((item) => item.id === modelId);
  const reasoningOptions = model?.reasoningOptions?.length
    ? model.reasoningOptions
    : (probe?.reasoningOptions ?? []);
  const reasoningSelect = must<HTMLSelectElement>(`#pref${prefix}Reasoning`);
  replacePreferenceOptions(reasoningSelect, reasoningOptions, reasoning, t("CLI 기본값"));
  reasoningSelect.disabled = probe ? !probe.capabilities.reasoningEffort : false;

  const tierSelect = must<HTMLSelectElement>(`#pref${prefix}Tier`);
  if (agentId === "claude") {
    replacePreferenceOptions(tierSelect, [], null, t("지원하지 않음"));
    tierSelect.disabled = true;
  } else {
    const serviceTierOptions = model?.serviceTierOptions?.length
      ? model.serviceTierOptions
      : (probe?.serviceTierOptions ?? []);
    replacePreferenceOptions(tierSelect, serviceTierOptions, serviceTier, t("CLI 기본값"));
    tierSelect.disabled = probe ? !probe.capabilities.serviceTier : false;
  }
}

function populatePreferenceAgent(
  agentId: AppConfig["agentId"],
  prefs: AppConfig["agentModels"][AppConfig["agentId"]],
): void {
  const prefix = preferencePrefix(agentId);
  const probe = lastAgents.find((item) => item.agentId === agentId);
  const models = probe?.models?.length
    ? probe.models
    : [{ id: "default", label: t("CLI 기본값") }];
  const selectedModel = prefs.model || "default";
  const modelSelect = must<HTMLSelectElement>(`#pref${prefix}Model`);
  const modelOptions = models.map((model) => ({ id: model.id, label: model.label }));
  if (!modelOptions.some((model) => model.id === selectedModel)) {
    modelOptions.push({ id: selectedModel, label: ui`${selectedModel} · 저장된 값` });
  }
  modelSelect.replaceChildren(...modelOptions.map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    return option;
  }));
  modelSelect.value = selectedModel;
  modelSelect.disabled = probe ? !probe.installed || !probe.capabilities.modelSelection : false;
  populatePreferenceCapabilities(agentId, selectedModel, prefs.reasoning, prefs.serviceTier);

  const status = must<HTMLElement>(`#pref${prefix}Probe`);
  if (!probe) {
    status.textContent = t("CLI 상태와 지원 모델을 확인하지 못했습니다.");
    return;
  }
  const install = !probe.installed
    ? t("미설치")
    : probe.loggedIn === true
      ? t("로그인됨")
      : probe.loggedIn === false
        ? t("로그인 필요")
        : t("로그인 상태 불명");
  const modelsLabel = probe.modelSource === "live"
    ? ui`CLI 감지 모델 ${probe.models.length - 1}개`
    : ui`fallback 모델 힌트 ${probe.models.length - 1}개`;
  const boundary = probe.capabilities.jsonStreaming
    && probe.capabilities.nativeTools
    ? t("CLI 스트리밍·앱 도구 연결 지원")
    : t("필수 실행 capability 부족");
  status.textContent = [
    install,
    probe.version,
    modelsLabel,
    boundary,
  ].filter(Boolean).join(" · ");
}

async function showLoginInstruction(button: HTMLButtonElement): Promise<void> {
  const agentId = button.dataset.prefLoginAgent === "codex" ? "codex" : "claude";
  const prefix = preferencePrefix(agentId);
  const command = must<HTMLElement>(`#pref${prefix}Login`);
  const detail = must<HTMLElement>(`#pref${prefix}LoginDetail`);
  button.disabled = true;
  button.textContent = t("확인 중…");
  try {
    const instruction = await requireApi().app.getLoginInstruction(agentId);
    command.style.display = "block";
    detail.style.display = "block";
    command.textContent = instruction.displayCommand;
    detail.textContent = instruction.available
      ? t("이 명령을 터미널에서 실행해 공급자의 대화형 로그인을 완료하세요.")
      : ui`${instruction.detail} CLI를 설치한 뒤 같은 명령을 실행하세요.`;
    if (instruction.available) {
      try {
        await navigator.clipboard.writeText(instruction.displayCommand);
        notify(ui`${instruction.displayCommand} 명령을 복사했습니다`, ui`${prefix} CLI 로그인`);
      } catch {
        notify(t("표시된 로그인 명령을 터미널에서 실행하세요"), ui`${prefix} CLI 로그인`);
      }
    }
  } catch (error) {
    command.style.display = "none";
    detail.style.display = "block";
    detail.textContent = error instanceof Error ? error.message : t("로그인 안내를 불러오지 못했습니다.");
  } finally {
    button.disabled = false;
    button.textContent = t("로그인 안내");
  }
}

async function submitNewProject(): Promise<void> {
  const api = requireApi();
  const title = (must<HTMLInputElement>("#npTitle").value ?? "").trim();
  if (!title) return;
  const transition = await runProjectTransition(
    "create",
    projectTransition,
    () => api.project.create({ title }),
    (result) => result.ok,
  );
  if (!transition.started) return;
  const result = transition.result;
  const data = unwrap(result, t("새 프로젝트"));
  if (data) {
    ($("#dlgNewProj") as HTMLDialogElement).close();
    location.href = "home.html";
  }
}

async function submitPrefs(): Promise<void> {
  const api = requireApi();
  const agentId = must<HTMLSelectElement>("#prefAgent").value as AppConfig["agentId"];
  const showWelcomeOnLaunch = must<HTMLInputElement>("#prefWelcome").checked;
  const prefs = (prefix: "Codex" | "Claude") => ({
    model: must<HTMLSelectElement>(`#pref${prefix}Model`).value.trim() || "default",
    reasoning: must<HTMLSelectElement>(`#pref${prefix}Reasoning`).value || null,
    serviceTier: prefix === "Codex" ? (must<HTMLSelectElement>("#prefCodexTier").value || null) : null,
  });
  try {
    const updated = await api.app.setConfig({
      agentId,
      agentModels: { ...(await api.app.getConfig()).agentModels, codex: prefs("Codex"), claude: prefs("Claude") },
      showWelcomeOnLaunch,
    });
    window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: updated }));
    ($("#dlgPrefs") as HTMLDialogElement).close();
    notify(t("에이전트 실행 설정을 저장했습니다"), t("설정"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("설정을 저장하지 못했습니다"), t("설정"));
  }
}

async function openPrefs(): Promise<void> {
  go("settings");
}

export async function openProjectFromSidebar(packagePath?: string): Promise<void> {
  const api = requireApi();
  const transition = await runProjectTransition("open", projectTransition, () => api.project.open(packagePath), result => result.ok && result.data !== null);
  if (!transition.started) return;
  const result = transition.result;
  if (!result.ok) notify(result.error.message, t("프로젝트 열기"));
  else if (result.data) location.href = "home.html";
}

export async function cmd(id: string): Promise<void> {
  if ((currentPage === "account" || document.body.hasAttribute("data-auth-pending"))
    && !["quit", "min", "zoom", "c", "v", "x", "undo", "redo"].includes(id)) return;
  if (PROJECT_COMMANDS.has(id) && !activeProject) return;
  if (pageCmd && (await pageCmd(id))) return;
  if (id === "home" || id === "editor" || id === "knowledge" || id === "glossary" || id === "comments" || id === "settings" || id === "community") {
    go(id);
    return;
  }
  if (id === "prepare") {
    store.set("munhae.prepare", "1");
    go("editor");
    return;
  }
  const api = requireApi();
  switch (id) {
    case "palette":
      openPalette();
      return;
    case "sidebar":
      toggleSidebar();
      return;
    case "ctxpane":
      toggleInsp();
      return;
    case "self":
      return;
    case "about": {
      const v = api ? await api.app.getVersion().catch(() => appVersion) : appVersion;
      notify(`Munhae Studio ${v}`, t("문해 정보"));
      return;
    }
    case "prefs":
      await openPrefs();
      return;
    case "ai": {
      if (!api) return notify("preload missing", t("AI 연결 상태"));
      const agents = await api.app.probeAgents();
      setAgentChrome(agents);
      notify(ui`${formatAgentDetail(agents)}. 토큰은 CLI가 보관합니다`, t("AI 연결 상태"));
      return;
    }
    case "updates":
      try { await api?.app.checkUpdates(); }
      catch { notify(t("업데이트 확인은 문해 데스크톱 앱에서 사용할 수 있습니다."), t("업데이트")); }
      return;
    case "quit":
      await api?.app.quit();
      return;
    case "newproj":
      ensureSharedDialogs();
      must<HTMLInputElement>("#npTitle").value = "";
      ($("#dlgNewProj") as HTMLDialogElement).showModal();
      must<HTMLInputElement>("#npTitle").focus();
      return;
    case "open":
      await openProjectFromSidebar();
      return;
    case "seeddemo": {
      if (!api) return;
      const transition = await runProjectTransition(
        "seed",
        projectTransition,
        () => api.project.seedDemo(),
        (result) => result.ok,
      );
      if (!transition.started) return;
      const result = transition.result;
      const data = unwrap(result, t("데모"));
      if (data) location.href = "home.html";
      return;
    }
    case "projects":
    case "close": {
      if (!api) return;
      const transition = await runProjectTransition(
        "close",
        projectTransition,
        () => api.project.close(),
        (result) => result.ok,
      );
      if (!transition.started) return;
      const result = transition.result;
      if (!result.ok) notify(result.error.message, t("닫기"));
      else location.href = "index.html";
      return;
    }
    case "backup": {
      if (!api) return;
      const result = await api.project.backup();
      if (!result.ok) notify(result.error.message, t("백업"));
      else if (result.data) notify(ui`백업을 저장했습니다\n${result.data}`, t("백업"));
      return;
    }
    case "help":
      showAppHelp(esc);
      return;
    case "min":
    case "zoom":
      notify(t("창 조절은 시스템 창 단추를 사용하세요"), t("창"));
      return;
    case "undo":
    case "redo":
    case "x":
    case "c":
    case "v":
      return;
    case "import":
      await openDocumentDialog(currentDocId(), true);
      return;
    case "export":
      openExport();
      return;
    case "run":
      store.set("munhae.prepare", "1");
      go("editor");
      return;
    case "newdoc":
      await openDocumentDialog(currentDocId());
      return;
    case "newfolder":
      await openDocumentDialog(currentDocId(), false, "container");
      return;
    case "find":
      openProjectSearch();
      return;
    default:
      notify(t("이 명령은 아직 연결되어 있지 않습니다"), t("문해"));
  }
}

function bindShellEvents(): void {
  document.addEventListener("click", (e) => {
    const ctx = $("#ctxmenu");
    if (ctx && !(e.target as HTMLElement).closest("#ctxmenu")) ctx.classList.remove("show");
  });
  const palIn = $("#palIn");
  const palList = $("#palList");
  if (palIn && palIn.dataset.bound !== "1") {
    palIn.dataset.bound = "1";
    palIn.addEventListener("input", () => {
      palSel = 0;
      renderPalette();
    });
    palIn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        palSel = Math.min(palSel + 1, palItems.length - 1);
        renderPalette();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        palSel = Math.max(palSel - 1, 0);
        renderPalette();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const o = palItems[palSel];
        if (o) {
          ($("#dlgPalette") as HTMLDialogElement).close();
          void cmd(o.id);
        }
      }
    });
  }
  if (palList && palList.dataset.bound !== "1") {
    palList.dataset.bound = "1";
    palList.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest(".pl-item");
      if (!(b instanceof HTMLElement)) return;
      ($("#dlgPalette") as HTMLDialogElement).close();
      const o = palItems[Number(b.dataset.i)];
      if (o) void cmd(o.id);
    });
  }
  if (!document.body.dataset.keysBound) {
    document.body.dataset.keysBound = "1";
    document.addEventListener("keydown", (e) => {
      const m = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (e.key === "Escape") {
        $("#ctxmenu")?.classList.remove("show");
      }
      if (m && !e.altKey && !e.shiftKey && e.code === "Comma") {
        e.preventDefault(); void cmd("prefs"); return;
      }
      if (m && !e.altKey && !e.shiftKey && k === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (enabled.has("find") && m && !e.altKey && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        void cmd("find");
        return;
      }
      if (enabled.has("export") && m && !e.altKey && !e.shiftKey && e.code === "KeyE") {
        e.preventDefault();
        void cmd("export");
        return;
      }
      if (e.metaKey && e.ctrlKey && k === "s") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (m && e.shiftKey && /^Digit[1-3]$/.test(e.code)) {
        e.preventDefault();
        const screens: ScreenId[] = ["home", "editor", "knowledge"];
        const idx = Number(e.code.slice(5)) - 1;
        const dest = screens[idx];
        if (dest) go(dest);
        return;
      }
      if (m && e.shiftKey && e.code === "KeyN") {
        e.preventDefault();
        void cmd("newproj");
        return;
      }
      if (m && !e.shiftKey && !e.altKey && e.code === "KeyO") {
        const typing = (e.target as HTMLElement).matches("textarea,input,[contenteditable=true]");
        if (!typing) {
          e.preventDefault();
          void cmd("open");
          return;
        }
      }
      if (m && e.altKey && e.code === "KeyI") {
        e.preventDefault();
        void cmd("ctxpane");
        return;
      }
      if (m && e.altKey && e.code === "KeyK") {
        e.preventDefault();
        void cmd("prepare");
        return;
      }
      const pal = $("#dlgPalette") as HTMLDialogElement | null;
      if (pal?.open) return;
      pageKeys?.(e, m);
    });
  }
  $("#tbSidebar")?.addEventListener("click", () => toggleSidebar());
  $("#tbInsp")?.addEventListener("click", () => toggleInsp());
  $("#sbPalette")?.addEventListener("click", () => openPalette());
}

export type Shell = {
  cmd: typeof cmd;
  toggleSidebar: typeof toggleSidebar;
  toggleInsp: typeof toggleInsp;
  openPalette: typeof openPalette;
  setSelfTitle: typeof setSelfTitle;
  api: MunhaeApi;
};

function initTitlebar(): void {
  const win = $("#win");
  const bar = $(".titlebar");
  const sidebarButton = $("#tbSidebar");
  if (!win || !bar || !sidebarButton || win.classList.contains("unified-titlebar")) return;
  win.classList.add("unified-titlebar");
  win.classList.toggle("native-titlebar", !!window.munhae);
  const navigation = document.createElement("div");
  navigation.className = "titlebar-navigation";
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", t("화면 탐색"));
  navigation.innerHTML = '<span class="titlebar-window-space" aria-hidden="true"><i></i><i></i><i></i></span>';
  navigation.append(sidebarButton);
  const nav = (window as Window & { navigation?: EventTarget & { canGoBack: boolean; canGoForward: boolean } }).navigation;
  for (const direction of ["back", "forward"] as const) {
    const button = document.createElement("button");
    button.className = "tb titlebar-history";
    button.type = "button";
    button.title = direction === "back" ? t("뒤로") : t("앞으로");
    button.setAttribute("aria-label", button.title);
    button.innerHTML = `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="${direction === "back" ? "M13 8H3m5-5L3 8l5 5" : "M3 8h10m-5-5 5 5-5 5"}"/></svg>`;
    const update = () => { button.disabled = !(direction === "back" ? nav?.canGoBack : nav?.canGoForward); };
    update();
    nav?.addEventListener("currententrychange", update);
    button.addEventListener("click", () => {
      if (beforeNavigate && !beforeNavigate()) return;
      if (direction === "back") history.back();
      else history.forward();
    });
    navigation.append(button);
  }
  const left = bar.querySelector(".tb-l");
  const right = bar.querySelector(".tb-r");
  if (left && right) {
    right.prepend(...left.children);
    left.remove();
  }
  const title = bar.querySelector(".tb-c");
  if (title && !title.querySelector(".proxy, .ic")) {
    const icon = document.createElement("span");
    icon.className = "titlebar-page-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = ic(PAGE_ICONS[currentPage] ?? "folder");
    title.prepend(icon);
  }
  bar.prepend(navigation);
  win.prepend(bar);
}

function initSidebarAccount(api: MunhaeApi): void {
  const link = $<HTMLAnchorElement>(".sb-account");
  const label = $(".sb-account-label");
  if (!link || !label) return;
  link.href = SCREEN_FILES.account;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    go("account");
  });
  const render = (state: AccountState) => {
    const user = state.status === "signed_in" ? state.user : null;
    const name = user?.displayName.trim() || user?.email || t("문해 계정");
    label.textContent = name;
    link.title = user ? [user.displayName, user.email].filter(Boolean).join(" · ") : t("문해 계정");
    link.setAttribute("aria-label", ui`${name} · 계정 설정 열기`);
  };
  let revision = 0;
  const unsubscribe = api.auth.onStateChanged((state) => {
    revision += 1;
    if (activeProject?.storageMode === "online" && (state.status !== "signed_in" || state.user?.id !== activeProject.accountId)) {
      document.body.dataset.authPending = "";
      location.replace("index.html");
      return;
    }
    render(state);
  });
  window.addEventListener("pagehide", unsubscribe, { once: true });
  void api.auth.getState().then((result) => {
    if (result.ok && revision === 0) render(result.data);
  }).catch(() => undefined);
}

export function initShell(opts: ShellOptions): Shell {
  const api = requireApi();
  initBackgroundMusic(api);
  initNotificationSounds(api);
  configureProjectTools({
    api,
    escape: esc,
    notify,
    currentDocumentId: currentDocId,
    openDocument: (documentNodeId) => go("editor", documentNodeId),
  });
  document.documentElement.dataset.platform = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";
  projectTransition = opts.projectTransition ?? {};
  beforeNavigate = opts.beforeNavigate;
  api.app.onCommand((id) => {
    void cmd(id);
  });
  currentPage = opts.page;
  pageCmd = opts.pageCmd;
  pageKeys = opts.pageKeys;
  extraPalette = opts.extraPalette ?? [];
  enabled = new Set<string>([...GLOBAL_ENABLED, ...(opts.extraEnabled ?? [])]);
  if (opts.page === "account") enabled = new Set(["quit", "min", "zoom", "c", "v", "x", "undo", "redo"]);
  if (opts.page === "welcome") {
    enabled.delete("close");
    enabled.delete("newdoc");
    enabled.delete("backup");
    enabled.delete("export");
    enabled.delete("find");
    enabled.delete("import");
  }
  selfTitle =
    opts.selfTitle ??
    ({
      welcome: t("시작 화면"),
      home: t("프로젝트 홈"),
      editor: t("편집"),
      knowledge: t("문맥"),
      glossary: t("용어집"),
      comments: t("코멘트"),
      context: t("문맥 편집"),
      settings: t("설정"),
      community: t("커뮤니티"),
      account: t("문해 계정"),
    }[opts.page] as string);
  ensureSharedDialogs();
  const tbSidebar = $("#tbSidebar");
  if (tbSidebar && !tbSidebar.innerHTML) tbSidebar.innerHTML = ic("sidebar");
  const tbInsp = $("#tbInsp");
  if (tbInsp && !tbInsp.innerHTML) tbInsp.innerHTML = ic("panel");
  initTitlebar();
  const sidebarTree = $("#sbTree");
  if (sidebarTree && !$("#sidebar > .munhae-brand")) {
    const brand = document.createElement("div");
    brand.className = "munhae-brand";
    brand.setAttribute("role", "img");
    brand.setAttribute("aria-label", t("문해 Munhae Studio"));
    brand.innerHTML = '<strong aria-hidden="true">文解</strong><small aria-hidden="true">MUNHAE<br>STUDIO</small>';
    sidebarTree.before(brand);
  }
  refreshSidebarChrome = mountSidebarChrome({
    api, project: () => activeProject, command: cmd, openProject: openProjectFromSidebar,
    error: message => notify(message, t("프로젝트")),
  });
  refreshSidebarChrome();
  bindShellEvents();
  initSidebarAccount(api);
  if (activeProject?.storageMode === "online") {
    projectChanges = initProjectChanges(api, activeProject);
    initOnlineWorkspace(api, activeProject);
  }
  if (activeProject) mcpChanges = initMcpChanges(api, activeProject, notify);
  if (store.get(SB_KEY) === "0") toggleSidebar(true);
  initSidebarResize();
  void api.app
    .getVersion()
    .then((v) => {
      appVersion = v;
      setAgentChrome(lastAgents, v);
    })
    .catch(() => undefined);
  if (opts.page !== "account") void Promise.all([api.app.probeAgents(), api.app.getConfig()])
    .then(([agents, config]) => setAgentChrome(agents, appVersion, config.agentId))
    .catch(() => undefined);
  return { cmd, toggleSidebar, toggleInsp, openPalette, setSelfTitle, api };
}

export { sidebarDocs };
export function setSidebarDocs(docs: DocumentListItem[]): void {
  sidebarDocs = docs;
}
