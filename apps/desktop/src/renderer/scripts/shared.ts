import type {
  AgentProbe,
  AppConfig,
  DocumentKind,
  DocumentListItem,
  IpcResult,
  MunhaeApi,
  ProjectSummary,
  VersionUiState,
} from "../../shared/munhae-api";
import { createBrowserApi } from "./browser-api";

export type ScreenId = "home" | "editor" | "knowledge";
export type PageId = "welcome" | ScreenId;
export type IconName =
  | "home"
  | "folder"
  | "sliders"
  | "book"
  | "sidebar"
  | "panel"
  | "chev"
  | "doc"
  | "image";

export type MenuEntry = readonly [label: string, kbd: string, id: string, checked?: boolean] | null;
export type MenuGroup = readonly [title: string, items: readonly MenuEntry[], app?: boolean];

export type PaletteItem = { g: string; l: string; k: string; id: string };

export type SbNode = {
  h?: string;
  id?: string;
  k?: ScreenId;
  ic?: IconName;
  lbl?: string;
  han?: boolean;
  kids?: SbNode[];
  cnt?: number;
  dot?: "ok" | "warn" | "draft";
  t?: string;
  tab?: string;
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
};

export const SCREEN_FILES: Record<ScreenId, string> = {
  home: "home.html",
  editor: "editor.html",
  knowledge: "knowledge.html",
};

export const ICONS: Record<IconName, string> = {
  home: '<path d="M2.5 8.2 8 3.2l5.5 5"/><path d="M4 7.5V13h8V7.5"/>',
  folder: '<path d="M2 4.5h4.2l1.5 1.5H14V13H2z"/>',
  sliders:
    '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/><circle cx="6" cy="4.5" r="1.7" fill="var(--sidebar)"/><circle cx="10.5" cy="8" r="1.7" fill="var(--sidebar)"/><circle cx="5" cy="11.5" r="1.7" fill="var(--sidebar)"/>',
  book: '<path d="M2.5 3.5h4A1.5 1.5 0 0 1 8 5v8.5a1.5 1.5 0 0 0-1.5-1.5h-4z"/><path d="M13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8.5A1.5 1.5 0 0 1 9.5 12h4z"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M10 3v10"/>',
  chev: '<path d="M6 4l4 4-4 4"/>',
  doc: '<path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3M6.5 8h3M6.5 10.5h3"/>',
  image:
    '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m2.5 11.5 3.5-3.5 3 3 2-2 2.5 2.5"/><circle cx="10.5" cy="6" r="1"/>',
};

const GLOBAL_ENABLED = [
  "about",
  "prefs",
  "ai",
  "quit",
  "newproj",
  "open",
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
  "min",
  "zoom",
  "self",
  "help",
  "plan",
  "schema",
  "seeddemo",
  "backup",
] as const;

const PALETTE_SKIP = new Set(["self", "x", "c", "v", "quit", "min", "zoom", "palette"]);

const DOC_KEY = "munhae.doc";
const SB_KEY = "munhae.sb";

let currentPage: PageId = "welcome";
let selfTitle = "시작 화면";
let enabled = new Set<string>(GLOBAL_ENABLED);
let extraPalette: PaletteItem[] = [];
let pageCmd: ShellOptions["pageCmd"];
let pageKeys: ShellOptions["pageKeys"];
let mbOpen: HTMLElement | null = null;
let palSel = 0;
let palItems: PaletteItem[] = [];
let lastAgents: AgentProbe[] = [];
let appVersion = "0.1.0";
const expanded = new Map<string, boolean>();
let sidebarDocs: DocumentListItem[] = [];
let sidebarCurrentDoc: string | null = null;
let sidebarTab: string | null = null;
let sidebarOnDoc: ((id: string, label: string) => void) | null = null;
let sidebarOnTab: ((tab: string) => void) | null = null;
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

export function notify(msg: string, title = "문해"): void {
  const n = $("#notif");
  const t = $("#nTitle");
  const m = $("#nMsg");
  if (!n || !t || !m) return;
  t.textContent = title;
  m.textContent = msg;
  n.classList.add("show");
  const prev = (n as HTMLElement & { _h?: number })._h;
  if (prev) window.clearTimeout(prev);
  (n as HTMLElement & { _h?: number })._h = window.setTimeout(() => n.classList.remove("show"), 3400);
}

export function unwrap<T>(result: IpcResult<T>, title = "문해"): T | null {
  if (result.ok) return result.data;
  notify(result.error.message, title);
  return null;
}

export function persistDoc(id: string): void {
  store.set(DOC_KEY, id);
}

export function readPersistedDoc(): string | null {
  return new URLSearchParams(location.search).get("doc") ?? store.get(DOC_KEY);
}

export function currentDocId(): string | null {
  return new URLSearchParams(location.search).get("doc") ?? store.get(DOC_KEY);
}

export function go(k: ScreenId, docId?: string): void {
  if (k === currentPage && !docId) return;
  const doc = docId ?? (k === "editor" ? currentDocId() : null);
  if (doc) persistDoc(doc);
  if (k === "editor") {
    location.href = doc ? `${SCREEN_FILES[k]}?doc=${encodeURIComponent(doc)}` : SCREEN_FILES[k];
    return;
  }
  location.href = SCREEN_FILES[k];
}

export async function requireProject(): Promise<ProjectSummary | null> {
  const api = requireApi();
  const current = await api.project.getCurrent();
  if (!current) {
    location.href = "index.html";
    return null;
  }
  return current;
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
  if (state === "confirmed") return "확정";
  if (state === "review") return "재검토 필요";
  if (kind === "source") return "원문안";
  if (kind === "punctuation") return "표점안";
  return "번역안";
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

export function kindLine(d: DocumentListItem): string {
  return d.genre ? `${d.structuralKind} · ${d.genre}` : d.structuralKind;
}

export const STRUCTURAL_KINDS: DocumentKind[] = [
  "collection",
  "work",
  "volume",
  "chapter",
  "section",
  "item",
];

export function agentSummary(agents: AgentProbe[]): { text: string; cls: "ok" | "warn" | "" } {
  const claude = agents.find((a) => a.agentId === "claude");
  const codex = agents.find((a) => a.agentId === "codex");
  if (claude?.installed && claude.loggedIn) return { text: "Claude CLI", cls: "ok" };
  if (codex?.installed && codex.loggedIn) return { text: "Codex CLI", cls: "ok" };
  if (claude?.installed) return { text: "Claude CLI · 로그인 필요", cls: "warn" };
  if (codex?.installed) return { text: "Codex CLI · 로그인 필요", cls: "warn" };
  if (claude && !claude.installed) return { text: "Claude CLI 미설치", cls: "warn" };
  return { text: "AI 미연결", cls: "" };
}

export function formatAgentDetail(agents: AgentProbe[]): string {
  if (!agents.length) return "에이전트를 확인할 수 없습니다";
  return agents
    .map((a) => {
      const name = a.agentId === "claude" ? "Claude CLI" : "Codex CLI";
      if (!a.installed) return `${name} 미설치`;
      if (a.loggedIn) return `${name} 로그인됨${a.version ? ` · ${a.version}` : ""}`;
      if (a.loggedIn === false) return `${name} 설치됨, 로그인 필요`;
      return `${name} 설치됨`;
    })
    .join(" · ");
}

export function setAgentChrome(agents: AgentProbe[], version?: string): void {
  lastAgents = agents;
  if (version) appVersion = version;
  const sum = agentSummary(agents);
  const mb = $("#menubar .mb-right .row");
  if (mb) {
    mb.innerHTML = `<i class="dot ${sum.cls}"></i>${esc(sum.text)}`;
  }
  const foot = $(".sb-foot");
  if (foot) {
    foot.innerHTML = `<i class="dot ${sum.cls}"></i>${esc(sum.text)}${sum.cls === "ok" ? " · 로그인됨" : ""}<span class="sp"></span><span class="mono">${esc(appVersion)}</span>`;
  }
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

function menus(): MenuGroup[] {
  return [
    [
      "문해",
      [
        ["문해 정보", "", "about"],
        null,
        ["설정…", "⌘,", "prefs"],
        ["AI 연결 상태…", "", "ai"],
        null,
        ["문해 종료", "⌘Q", "quit"],
      ],
      true,
    ],
    [
      "파일",
      [
        ["새 프로젝트…", "⇧⌘N", "newproj"],
        ["프로젝트 열기…", "⌘O", "open"],
        null,
        ["새 문서 node…", "⌘N", "newdoc"],
        ["원문 가져오기…", "", "import"],
        null,
        ["백업 만들기…", "", "backup"],
        ["내보내기…", "⌘E", "export"],
        null,
        ["프로젝트 닫기", "⌘W", "close"],
      ],
    ],
    [
      "편집",
      [
        ["실행 취소", "⌘Z", "undo"],
        ["다시 실행", "⇧⌘Z", "redo"],
        null,
        ["잘라내기", "⌘X", "x"],
        ["복사", "⌘C", "c"],
        ["붙여넣기", "⌘V", "v"],
        null,
        ["찾기…", "⌘F", "find"],
      ],
    ],
    [
      "보기",
      [
        ["사이드바 보기/가리기", "⌃⌘S", "sidebar"],
        ["참고 자료 패널", "⌥⌘R", "refpane"],
        [currentPage === "editor" ? "문맥·AI 패널" : "검사기 패널", "⌥⌘I", "ctxpane"],
        null,
        ["표점 전문", "⌘1", "v-source"],
        ["대조", "⌘2", "v-parallel"],
        ["번역 전문", "⌘3", "v-full"],
        null,
        ["구조 표시", "", "struct"],
        ["앵커 ID 표시", "", "keys"],
      ],
    ],
    [
      "번역",
      [
        ["AI 번역…", "⌥⌘K", "prepare"],
        ["Reflection 다시 요청", "", "reflect"],
        null,
        ["다음 블록과 합치기", "⌥⌘M", "merge"],
        ["블록 나누기…", "⌥⌘S", "split"],
        ["앵커 연결…", "⌥⌘L", "link"],
        null,
        ["변경 비교", "⌘D", "diff"],
        ["번역안 확정", "⇧⌘↩", "confirm"],
      ],
    ],
    [
      "이동",
      [
        ["프로젝트 홈", "⇧⌘1", "home"],
        ["편집", "⇧⌘2", "editor"],
        ["공통 지식", "⇧⌘3", "knowledge"],
        null,
        ["명령 검색…", "⌘K", "palette"],
      ],
    ],
    [
      "창",
      [
        ["최소화", "⌘M", "min"],
        ["확대/축소", "", "zoom"],
        null,
        [selfTitle, "", "self", true],
      ],
    ],
    [
      "도움말",
      [
        ["문해 도움말", "", "help"],
        ["plan.md 보기", "", "plan"],
        ["schema.md 보기", "", "schema"],
      ],
    ],
  ];
}

export function renderMenubar(): void {
  const bar = $("#menubar");
  if (!bar) return;
  const sum = agentSummary(lastAgents);
  bar.innerHTML =
    menus()
      .map(([t, items, app], i) => {
        const body = items
          .map((it) =>
            it
              ? `<button role="menuitem" data-cmd="${it[2]}"${enabled.has(it[2]) ? "" : " disabled"}${it[3] ? ' class="checked"' : ""}>${esc(it[0])}<kbd>${esc(it[1])}</kbd></button>`
              : "<hr>",
          )
          .join("");
        return `<div class="mb-item${app ? " app" : ""}" data-mi="${i}"><span>${esc(t)}</span><div class="menu" role="menu">${body}</div></div>`;
      })
      .join("") +
    `<div class="mb-right"><span class="row" style="gap:5px"><i class="dot ${sum.cls}"></i>${esc(sum.text)}</span><span id="clock"></span></div>`;
  tick();
}

function openMenu(el: HTMLElement | null): void {
  if (mbOpen) mbOpen.classList.remove("open");
  mbOpen = el;
  $("#menubar")?.classList.toggle("active", !!el);
  el?.classList.add("open");
}

function tick(): void {
  const c = $("#clock");
  if (c) c.textContent = fmtClock();
}

function paletteItems(q: string): PaletteItem[] {
  const out: PaletteItem[] = [...extraPalette];
  for (const [t, items] of menus()) {
    for (const it of items) {
      if (it && enabled.has(it[2]) && !PALETTE_SKIP.has(it[2])) {
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
      .join("") || '<div class="pl-h">일치하는 명령이 없습니다</div>';
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
    notify("시작 화면에는 사이드바가 없습니다. 프로젝트를 열면 ⌃⌘S로 접을 수 있습니다", "보기");
    return;
  }
  const hide = force !== undefined ? force : !w.classList.contains("sb-hidden");
  w.classList.toggle("sb-hidden", hide);
  store.set(SB_KEY, hide ? "0" : "1");
  btn?.classList.toggle("is-on", !hide);
}

export function toggleInsp(): void {
  const s = $("#split");
  const btn = $("#tbInsp");
  if (!s) return;
  s.classList.toggle("no-insp");
  btn?.classList.toggle("is-on", !s.classList.contains("no-insp"));
}

function sbNode(n: SbNode, d: number): string {
  if (n.h === "문서") {
    return `<div class="sb-h-row"><div class="sb-h">문서</div><button class="sb-add" type="button" data-new-parent="" title="새 문서 node">+</button></div>`;
  }
  if (n.h) return `<div class="sb-h">${esc(n.h)}</div>`;
  const kids = !!n.kids?.length;
  const cur = n.contextFor
    ? currentPage === "knowledge" && sidebarTab === "context" && n.contextFor === sidebarCurrentDoc
    : n.tab
    ? n.tab === sidebarTab
    : n.k
      ? n.k === currentPage && (!n.docId || n.docId === sidebarCurrentDoc)
      : n.docId
        ? n.docId === sidebarCurrentDoc
        : false;
  const exp = n.id ? expanded.get(n.id) !== false : true;
  const parts: string[] = [];
  parts.push(`<div class="sb-row">`);
  parts.push(
    `<button class="sb-item${cur ? " is-current" : ""}" type="button" data-depth="${d}" style="--sb-depth:${d}"${kids && n.id ? ` aria-expanded="${exp}"` : ""}${n.k ? ` data-go="${n.k}"` : ""}${n.tab ? ` data-tab="${esc(n.tab)}"` : ""}${n.docId ? ` data-doc-id="${esc(n.docId)}"` : ""}${n.contextFor ? ` data-context-for="${esc(n.contextFor)}"` : ""}${n.t ? ` title="${esc(n.t)}"` : ""}${cur ? ' aria-current="page"' : ""}>`,
  );
  if (kids && n.id) {
    parts.push(
      `<svg class="ic chev" viewBox="0 0 16 16" data-exp="${esc(n.id)}" aria-hidden="true">${ICONS.chev}</svg>`,
    );
  }
  if (n.ic) parts.push(ic(n.ic));
  parts.push(`<span class="lbl${n.han ? " hanmun" : ""}">${esc(n.lbl ?? "")}</span>`);
  if (n.cnt) parts.push(`<span class="cnt">${n.cnt}</span>`);
  if (n.dot) parts.push(`<i class="dot ${n.dot}"></i>`);
  parts.push("</button>");
  if (n.docId && n.canHaveChildren) {
    parts.push(
      `<button class="sb-add" type="button" data-new-parent="${esc(n.docId)}" title="하위 문서 만들기">+</button>`,
    );
  }
  parts.push("</div>");
  if (kids && exp && n.kids) parts.push(n.kids.map((k) => sbNode(k, d + 1)).join(""));
  return parts.join("");
}

export function docsToTree(docs: DocumentListItem[]): SbNode[] {
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
        lbl: d.originalTitle || d.title,
        han: true,
        ic: isContainer ? "folder" : "doc",
        kids: [
          {
            id: `context:${d.id}`,
            contextFor: d.id,
            lbl: "문맥",
            ic: "sliders",
            cnt: d.contextCount || undefined,
            t: `${d.originalTitle || d.title} · 직접 문맥과 상속 문맥 ${d.contextCount}개`,
          },
          ...documentKids,
        ],
        cnt: isContainer ? documentKids.length || undefined : undefined,
        dot,
        t: `${d.title} · ${d.isMaster ? "프로젝트 마스터 폴더" : isContainer ? "목차 폴더" : "원문 문서"}`,
        canHaveChildren: isContainer,
      };
    });
  };
  return walk("root");
}

export function defaultSidebarTree(docs: DocumentListItem[], opts?: { knowledgeKids?: SbNode[] }): SbNode[] {
  const docTree = docsToTree(docs);
  const kn: SbNode = opts?.knowledgeKids
    ? { id: "kn", ic: "book", lbl: "공통 지식", k: "knowledge", kids: opts.knowledgeKids }
    : { k: "knowledge", ic: "book", lbl: "공통 지식" };
  if (opts?.knowledgeKids && !expanded.has("kn")) expanded.set("kn", true);
  return [
    { h: "프로젝트" },
    { k: "home", ic: "home", lbl: "홈" },
    { h: "문서" },
    ...docTree,
    { h: "프로젝트 공통" },
    kn,
  ];
}

export function renderSidebar(
  tree: SbNode[],
  opts?: { currentDocId?: string | null; currentTab?: string | null },
): void {
  const root = $("#sbTree");
  if (!root) return;
  if (opts?.currentDocId !== undefined) sidebarCurrentDoc = opts.currentDocId;
  if (opts?.currentTab !== undefined) sidebarTab = opts.currentTab;
  root.innerHTML = tree.map((n) => sbNode(n, 0)).join("");
}

let sidebarOnNew: ((parentId: string | null) => void) | null = null;

export function bindSidebar(
  onDoc?: (id: string, label: string) => void,
  onTab?: (tab: string) => void,
  treeFn?: () => SbNode[],
  onNew?: (parentId: string | null) => void,
  options?: { selectExpandable?: boolean },
): void {
  sidebarOnDoc = onDoc ?? null;
  sidebarOnTab = onTab ?? null;
  sidebarOnNew =
    onNew ??
    ((parentId) => {
      store.set("munhae.openNewDoc", "1");
      store.set("munhae.newDocParent", parentId ?? "");
      go("home");
    });
  const root = $("#sbTree");
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const add = target.closest("[data-new-parent]");
    if (add instanceof HTMLElement && root.contains(add)) {
      e.preventDefault();
      e.stopPropagation();
      const raw = add.getAttribute("data-new-parent") ?? "";
      sidebarOnNew?.(raw === "" ? null : raw);
      return;
    }
    const exp = target.closest("[data-exp]");
    if (exp instanceof HTMLElement && root.contains(exp) && exp.dataset.exp) {
      e.preventDefault();
      e.stopPropagation();
      const id = exp.dataset.exp;
      expanded.set(id, expanded.get(id) === false);
      if (treeFn) renderSidebar(treeFn(), { currentDocId: sidebarCurrentDoc, currentTab: sidebarTab });
      return;
    }
    const b = target.closest(".sb-item");
    if (!(b instanceof HTMLElement)) return;
    if (b.dataset.contextFor) {
      location.href = `knowledge.html?node=${encodeURIComponent(b.dataset.contextFor)}#context`;
      return;
    }
    if (b.hasAttribute("aria-expanded") && b.dataset.docId) {
      e.preventDefault();
      const id = b.dataset.docId;
      expanded.set(id, expanded.get(id) === false);
      if (treeFn) renderSidebar(treeFn(), { currentDocId: sidebarCurrentDoc, currentTab: sidebarTab });
      if (options?.selectExpandable) sidebarOnDoc?.(id, b.textContent ?? "");
      return;
    }
    if (b.dataset.tab) {
      sidebarOnTab?.(b.dataset.tab);
      return;
    }
    if (b.dataset.go) {
      const k = b.dataset.go as ScreenId;
      const docId = b.dataset.docId;
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
  renderMenubar();
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
    `<dialog id="dlgNewProj">
      <form method="dialog" id="newProjForm">
        <div class="dl-h">새 프로젝트</div>
        <div class="dl-b">
          <div class="field"><label for="npTitle">제목</label><input class="input" id="npTitle" required placeholder="예: 훈민정음 문헌 번역"></div>
          <p class="muted" style="font-size:12px">폴더를 고르면 .munhae 프로젝트가 만들어집니다. 서버로 전송하지 않습니다.</p>
        </div>
        <div class="dl-f"><button class="btn" type="button" id="npCancel">취소</button><button class="btn btn-primary" type="submit">만들기</button></div>
      </form>
    </dialog>`,
  );
  ensureDialog(
    "dlgPrefs",
    `<dialog id="dlgPrefs">
      <form method="dialog" id="prefsForm">
        <div class="dl-h">설정</div>
        <div class="dl-b">
          <div class="field"><label for="prefAgent">기본 에이전트</label>
            <select class="select" id="prefAgent"><option value="claude">Claude CLI</option><option value="codex">Codex CLI</option></select>
          </div>
          <label class="check"><input type="checkbox" id="prefWelcome"> 실행할 때 시작 창 표시</label>
          <p class="muted" style="font-size:12px">agent · model · reasoning preference는 프로젝트 밖 app-config.json에 저장됩니다. 토큰은 저장하지 않습니다.</p>
        </div>
        <div class="dl-f"><button class="btn" type="button" id="prefCancel">취소</button><button class="btn btn-primary" type="submit">저장</button></div>
      </form>
    </dialog>`,
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
  }
}

async function submitNewProject(): Promise<void> {
  const api = requireApi();
  const title = (must<HTMLInputElement>("#npTitle").value ?? "").trim();
  if (!title) return;
  const result = await api.project.create({ title });
  const data = unwrap(result, "새 프로젝트");
  if (data) {
    ($("#dlgNewProj") as HTMLDialogElement).close();
    location.href = "home.html";
  }
}

async function submitPrefs(): Promise<void> {
  const api = requireApi();
  const agentId = must<HTMLSelectElement>("#prefAgent").value as AppConfig["agentId"];
  const showWelcomeOnLaunch = must<HTMLInputElement>("#prefWelcome").checked;
  await api.app.setConfig({ agentId, showWelcomeOnLaunch });
  ($("#dlgPrefs") as HTMLDialogElement).close();
  notify("설정을 저장했습니다", "설정");
}

async function openPrefs(): Promise<void> {
  ensureSharedDialogs();
  const api = requireApi();
  const cfg = await api.app.getConfig();
  must<HTMLSelectElement>("#prefAgent").value = cfg.agentId;
  must<HTMLInputElement>("#prefWelcome").checked = cfg.showWelcomeOnLaunch;
  ($("#dlgPrefs") as HTMLDialogElement).showModal();
}

export async function cmd(id: string): Promise<void> {
  if (pageCmd && (await pageCmd(id))) return;
  if (id === "home" || id === "editor" || id === "knowledge") {
    go(id);
    return;
  }
  if (id === "prepare") {
    store.set("munhae.prepare", "1");
    go("editor");
    return;
  }
  const api = window.munhae;
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
      notify(`Munhae Studio ${v} · Phase 1 로컬 CAT`, "문해 정보");
      return;
    }
    case "prefs":
      await openPrefs();
      return;
    case "ai": {
      if (!api) return notify("preload missing", "AI 연결 상태");
      const agents = await api.app.probeAgents();
      setAgentChrome(agents);
      notify(`${formatAgentDetail(agents)}. 토큰은 CLI가 보관합니다`, "AI 연결 상태");
      return;
    }
    case "quit":
      await api?.app.quit();
      return;
    case "newproj":
      ensureSharedDialogs();
      must<HTMLInputElement>("#npTitle").value = "";
      ($("#dlgNewProj") as HTMLDialogElement).showModal();
      must<HTMLInputElement>("#npTitle").focus();
      return;
    case "open": {
      if (!api) return;
      const result = await api.project.open();
      if (!result.ok) {
        notify(result.error.message, "프로젝트 열기");
        return;
      }
      if (result.data) location.href = "home.html";
      return;
    }
    case "seeddemo": {
      if (!api) return;
      const result = await api.project.seedDemo();
      const data = unwrap(result, "데모");
      if (data) location.href = "home.html";
      return;
    }
    case "close": {
      if (!api) return;
      const result = await api.project.close();
      if (!result.ok) notify(result.error.message, "닫기");
      else location.href = "index.html";
      return;
    }
    case "backup": {
      if (!api) return;
      const result = await api.project.backup();
      if (!result.ok) notify(result.error.message, "백업");
      else if (result.data) notify(`백업을 저장했습니다\n${result.data}`, "백업");
      return;
    }
    case "plan":
    case "schema":
      notify(`${id}.md는 저장소 루트에 있습니다`, "도움말");
      return;
    case "help":
      notify("문해는 로컬 CAT입니다. 원문·표점·번역안을 프로젝트 파일에 저장하며 서버로 보내지 않습니다", "도움말");
      return;
    case "min":
    case "zoom":
      notify("창 조절은 시스템 창 단추를 사용하세요", "창");
      return;
    case "undo":
    case "redo":
    case "x":
    case "c":
    case "v":
      return;
    case "import":
      notify("텍스트 파일 가져오기는 새 문서 대화상자에서 할 수 있습니다", "가져오기");
      return;
    case "export":
      notify("확정 번역 내보내기는 아직 연결되지 않았습니다", "내보내기");
      return;
    case "run":
      notify("M3에서 로컬 CLI 호출이 연결됩니다", "번역 실행");
      return;
    case "reflect":
      notify("M3에서 로컬 CLI 호출이 연결됩니다", "Reflection");
      return;
    case "newdoc":
      go("home");
      store.set("munhae.openNewDoc", "1");
      return;
    case "find":
      notify("찾기는 이 화면에 연결되어 있지 않습니다", "편집");
      return;
    default:
      notify("이 명령은 아직 연결되어 있지 않습니다", "문해");
  }
}

function bindShellEvents(): void {
  const bar = $("#menubar");
  if (bar && bar.dataset.bound !== "1") {
    bar.dataset.bound = "1";
    bar.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button[data-cmd]");
      if (b instanceof HTMLButtonElement) {
        if (!b.disabled) {
          openMenu(null);
          void cmd(b.dataset.cmd ?? "");
        }
        return;
      }
      const mi = (e.target as HTMLElement).closest(".mb-item");
      if (mi instanceof HTMLElement) openMenu(mbOpen === mi ? null : mi);
    });
    bar.addEventListener("mouseover", (e) => {
      const mi = (e.target as HTMLElement).closest(".mb-item");
      if (mbOpen && mi instanceof HTMLElement && mi !== mbOpen) openMenu(mi);
    });
  }
  document.addEventListener("click", (e) => {
    if (mbOpen && !(e.target as HTMLElement).closest("#menubar")) openMenu(null);
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
        openMenu(null);
        $("#ctxmenu")?.classList.remove("show");
      }
      if (m && !e.altKey && !e.shiftKey && k === "k") {
        e.preventDefault();
        openPalette();
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

export function initShell(opts: ShellOptions): Shell {
  const api = requireApi();
  document.documentElement.dataset.platform = /Mac|iPhone|iPad/.test(navigator.platform) ? "mac" : "other";
  api.app.onCommand((id) => {
    void cmd(id);
  });
  currentPage = opts.page;
  pageCmd = opts.pageCmd;
  pageKeys = opts.pageKeys;
  extraPalette = opts.extraPalette ?? [];
  enabled = new Set<string>([...GLOBAL_ENABLED, ...(opts.extraEnabled ?? [])]);
  if (opts.page === "welcome") {
    enabled.delete("close");
    enabled.delete("newdoc");
    enabled.delete("backup");
    enabled.delete("export");
    enabled.delete("import");
  }
  selfTitle =
    opts.selfTitle ??
    ({
      welcome: "시작 화면",
      home: "프로젝트 홈",
      editor: "편집",
      knowledge: "공통 지식",
    }[opts.page] as string);
  ensureSharedDialogs();
  const tbSidebar = $("#tbSidebar");
  if (tbSidebar && !tbSidebar.innerHTML) tbSidebar.innerHTML = ic("sidebar");
  const tbInsp = $("#tbInsp");
  if (tbInsp && !tbInsp.innerHTML) tbInsp.innerHTML = ic("panel");
  renderMenubar();
  bindShellEvents();
  tick();
  window.setInterval(tick, 30000);
  if (store.get(SB_KEY) === "0") toggleSidebar(true);
  void api.app
    .getVersion()
    .then((v) => {
      appVersion = v;
      setAgentChrome(lastAgents, v);
    })
    .catch(() => undefined);
  void api.app
    .probeAgents()
    .then((a) => setAgentChrome(a, appVersion))
    .catch(() => undefined);
  return { cmd, toggleSidebar, toggleInsp, openPalette, setSelfTitle, api };
}

export { sidebarDocs };
export function setSidebarDocs(docs: DocumentListItem[]): void {
  sidebarDocs = docs;
}
