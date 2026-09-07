import type {
  DocumentListItem,
  HomeView,
} from "../../shared/munhae-api";
import {
  $,
  bindSidebar,
  defaultSidebarTree,
  esc,
  findDefaultDoc,
  go,
  initShell,
  must,
  notify,
  openDocumentDialog,
  persistDoc,
  renderSidebar,
  requireProject,
  rowStatus,
  setSelfTitle,
  setSidebarDocs,
  shortPath,
  stateLabel,
  tagHtml,
  unwrap,
} from "./shared";
import { openConfirmedExport } from "./project-tools";

const project = await requireProject();
if (!project) throw new Error("redirect");

const api = initShell({
  page: "home",
  extraEnabled: ["newdoc", "import", "backup", "export", "ctxpane"],
  selfTitle: `${project.title} — ${shortPath(project.packagePath)}`,
  pageCmd,
  pageKeys,
}).api;

let view: HomeView | null = null;
let sel: string | null = null;
let treeDocs: DocumentListItem[] = [];

function tree(): ReturnType<typeof defaultSidebarTree> {
  return defaultSidebarTree(treeDocs);
}

function parentOf(d: DocumentListItem): string {
  if (!d.parentId || !view) return "(최상위)";
  const p = view.documents.find((x) => x.id === d.parentId);
  return p ? p.originalTitle || p.title : "(최상위)";
}

function isSourceUnit(d: DocumentListItem): boolean {
  return d.nodeRole === "source_unit";
}

function ancestorPath(d: DocumentListItem): string {
  if (!view) return "";
  const labels: string[] = [];
  let parentId = d.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = view.documents.find((item) => item.id === parentId);
    if (!parent) break;
    labels.unshift(parent.originalTitle || parent.title);
    parentId = parent.parentId;
  }
  return labels.join(" › ");
}

function descendantSourceCount(d: DocumentListItem): number {
  const currentView = view;
  if (!currentView) return 0;
  return currentView.documents.filter((candidate) => {
    if (!isSourceUnit(candidate)) return false;
    let parentId = candidate.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      if (parentId === d.id) return true;
      seen.add(parentId);
      parentId = currentView.documents.find((item) => item.id === parentId)?.parentId ?? null;
    }
    return false;
  }).length;
}

function renderTable(): void {
  if (!view) return;
  const q = (must<HTMLInputElement>("#q").value ?? "").trim();
  const st = must<HTMLSelectElement>("#statusSel").value;
  const docs = view.documents;
  const sourceUnits = docs.filter(isSourceUnit);
  const match = (d: DocumentListItem): boolean => {
    const name = `${ancestorPath(d)} ${d.title} ${d.originalTitle ?? ""}`;
    if (q && !name.includes(q)) return false;
    if (!st) return true;
    const rs = rowStatus(d);
    if (st === "draft") return rs === "draft" || rs === "progress";
    return rs === st;
  };
  const visible = sourceUnits.filter(match);
  const body = must("#docBody");
  body.innerHTML = visible.length
    ? visible
        .map((d) => {
          const src = stateLabel("source", d.sourceState);
          const punc = stateLabel("punctuation", d.punctuationState);
          const tr = stateLabel("translation", d.translationState);
          const path = ancestorPath(d);
          return `<tr class="${sel === d.id ? "is-active" : ""}" data-id="${esc(d.id)}" tabindex="0" aria-selected="${sel === d.id}">
        <td><div class="work-cell"><div class="work-title"><span class="name">${esc(d.originalTitle || d.title)}</span></div>${path ? `<span class="path">${esc(path)}</span>` : ""}</div></td>
        <td>${tagHtml(src)}</td><td>${tagHtml(punc)}</td><td>${tagHtml(tr)}</td>
        <td>${d.uncertaintyCount ? `<span class="mono">${d.uncertaintyCount}</span>` : '<span class="muted">—</span>'}</td>
      </tr>`;
        })
        .join("")
    : `<tr class="is-empty"><td colspan="5"><div class="home-empty"><b>${q || st ? "조건에 맞는 원문 단위가 없습니다." : "아직 원문 작업 단위가 없습니다."}</b><span>${q || st ? "검색어나 상태 필터를 바꿔 보세요." : "왼쪽 목차에서 권·장 같은 구조를 만든 뒤, 그 아래에 원문 단위를 추가하세요."}</span>${q || st ? "" : '<button class="btn btn-sm" type="button" data-add-source>원문 단위 추가</button>'}</div></td></tr>`;
  const count = visible.length;
  must("#rowCount").textContent = String(count);
  const confirmed = sourceUnits.filter((d) => d.translationState === "confirmed").length;
  must("#scopeMeta").innerHTML = `<b class="mono" id="rowCount" style="color:var(--fg)">${count}</b>개 원문 단위 · 확정 ${confirmed}`;
  renderSel();
}

function renderSel(): void {
  if (!view) return;
  const d = view.documents.find((x) => x.id === sel);
  must("#selMeta").textContent = d ? d.id.slice(0, 8) : "";
  if (!d) {
    must("#selBody").innerHTML = '<p class="muted" style="padding:2px 0 4px">목차 또는 원문 단위를 선택하세요.</p>';
    must("#btnContinue").textContent = "원문 단위 추가";
    return;
  }
  const label = d.originalTitle || d.title;
  const btn = must("#btnContinue");
  if (!isSourceUnit(d)) {
    const sourceCount = descendantSourceCount(d);
    must("#selBody").innerHTML = `<div class="sel-title">${esc(label)}</div>
      <dl class="kv"><dt>역할</dt><dd>목차 폴더</dd><dt>상위</dt><dd class="hanmun">${esc(parentOf(d))}</dd><dt>하위 원문</dt><dd>${sourceCount}건</dd></dl>
      <p class="structure-note">권·장 같은 목차 항목은 번역 진행률에 포함되지 않습니다. 실제 원문이 연결된 하위 항목부터 작업 단위로 셉니다.</p>
      <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn btn-sm" id="selMetadata" type="button">문서 정보</button><button class="btn btn-sm" id="selAddSource" type="button">하위 원문 추가</button></div>`;
    $("#selAddSource")?.addEventListener("click", () => openNewDoc(d.id));
    $("#selMetadata")?.addEventListener("click", () => openMetadata(d.id));
    btn.textContent = `${label} 아래 원문 추가`;
    return;
  }
  const src = stateLabel("source", d.sourceState);
  const punc = stateLabel("punctuation", d.punctuationState);
  const tr = stateLabel("translation", d.translationState);
  must("#selBody").innerHTML = `<div class="sel-title">${esc(d.originalTitle || d.title)}</div>
    <dl class="kv"><dt>상위</dt><dd class="hanmun">${esc(parentOf(d))}</dd><dt>원문</dt><dd>${tagHtml(src)}</dd><dt>표점</dt><dd>${tagHtml(punc)}</dd><dt>번역</dt><dd>${tagHtml(tr)}</dd><dt>불확실성</dt><dd>${d.uncertaintyCount ? `${d.uncertaintyCount}건 열림` : "—"}</dd></dl>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="btn btn-sm" id="selMetadata" type="button">문서 정보</button><button class="btn btn-sm" id="selOpen" type="button">열기 <kbd>↩</kbd></button></div>`;
  $("#selOpen")?.addEventListener("click", () => openDoc(d.id));
  $("#selMetadata")?.addEventListener("click", () => openMetadata(d.id));
  btn.textContent = `${label} 편집`;
}

function renderProgress(): void {
  if (!view) return;
  const p = view.progress;
  const total = p.total || 1;
  const rows: Array<[string, number, string?]> = [
    ["원문 확정", p.sourceConfirmed],
    ["표점 확정", p.punctuationConfirmed],
    ["번역안", p.translationDraft],
    ["번역 확정", p.translationConfirmed, "var(--ok)"],
  ];
  must("#progTail").textContent = `원문 단위 ${p.total}건`;
  must("#progBody").innerHTML = rows
    .map(([lab, n, color]) => {
      const pct = Math.round((n / total) * 100);
      const bg = color ? `background:${color}` : "";
      return `<div class="prog-row"><span>${lab}</span><div class="bar"><i style="width:${pct}%;${bg}"></i></div><span class="mono">${n}/${p.total}</span></div>`;
    })
    .join("");
  must("#shareBody").innerHTML =
    `확정 <b class="mono">${p.translationConfirmed}</b>건 · 공유 <b class="mono">0</b>건. 로컬 프로젝트는 서버로 전송하지 않으며, 공유는 확정과 별개로 사용자가 선택할 때만 이루어집니다.`;
}

function renderUnc(): void {
  if (!view) return;
  const list = must("#uncList");
  if (!view.uncertainties.length) {
    list.innerHTML = '<p class="muted" style="font-size:12px">열린 불확실성이 없습니다.</p>';
    return;
  }
  list.innerHTML = view.uncertainties
    .map(
      (u) =>
        `<div class="li"><div><b>${esc(u.id.slice(0, 8))}</b> ${esc(u.label)}<div class="sub">${esc(u.locator)}</div></div><span class="tag tag-warn">${esc(u.category)}</span></div>`,
    )
    .join("");
}

function renderRecentWork(): void {
  if (!view) return;
  const list = must("#recentList");
  if (!view.recent.length) {
    list.innerHTML = '<p class="muted" style="font-size:12px">최근 작업이 없습니다.</p>';
    return;
  }
  list.innerHTML = view.recent
    .map((r) => {
      const cls =
        r.tag === "확정" ? "tag-ok" : r.tag === "재검토" || r.tag.includes("재검토") ? "tag-warn" : "tag-draft";
      return `<div class="li"><div><b class="hanmun">${esc(r.title)}</b> ${esc(r.summary)}<div class="sub">${esc(r.when)}</div></div><span class="tag ${cls}">${esc(r.tag)}</span></div>`;
    })
    .join("");
}

function renderAgents(): void {
  if (!view) return;
  const dl = must("#agentList");
  if (!view.agents.length) {
    dl.innerHTML = "<dt>에이전트</dt><dd class=\"muted\">확인되지 않음</dd>";
    return;
  }
  dl.innerHTML = view.agents
    .map((a) => {
      const name = a.agentId === "antigravity" ? "Antigravity CLI" : a.agentId === "claude" ? "Claude CLI" : "Codex CLI";
      const ok = a.installed && a.loggedIn;
      const cls = ok ? "ok" : "warn";
      const detail = !a.installed
        ? "미설치"
        : a.loggedIn
          ? `로그인됨 · probe ${a.lastCheckedAt ? a.lastCheckedAt.slice(11, 16) : ""}`
          : "설치됨 · 로그인 필요";
      return `<dt><span class="row" style="gap:6px"><i class="dot ${cls}"></i>${name}</span></dt><dd>${esc(detail)}</dd>`;
    })
    .join("");
}

function openNewDoc(parentId: string | null = sel): void {
  void openDocumentDialog(parentId);
}

function openNewSource(): void {
  const selected = view?.documents.find((d) => d.id === sel);
  openNewDoc(selected && isSourceUnit(selected) ? selected.parentId : sel);
}

function openDoc(id: string): void {
  const d = view?.documents.find((x) => x.id === id);
  if (!d) return;
  if (!isSourceUnit(d)) {
    notify(`${d.originalTitle || d.title}: 목차 구조 항목입니다. 하위에 원문 단위를 추가하세요`);
    return;
  }
  persistDoc(id);
  go("editor", id);
}

function openMetadata(id: string): void {
  location.href = `knowledge.html?node=${encodeURIComponent(id)}#context`;
}

function openSourceImport(): void {
  void openDocumentDialog(sel, true);
}

function pageCmd(id: string): boolean {
  switch (id) {
    case "newdoc":
      openNewSource();
      return true;
    case "backup":
      return false;
    case "export":
      openConfirmedExport();
      return true;
    case "import":
      openSourceImport();
      return true;
    case "ctxpane":
      return false;
    case "find":
      return false;
  }
  return false;
}

function pageKeys(e: KeyboardEvent, m: boolean): void {
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyN") {
    e.preventDefault();
    openNewSource();
  } else if (m && !e.shiftKey && e.code === "KeyE") {
    e.preventDefault();
    openConfirmedExport();
  } else if (m && !e.shiftKey && e.code === "KeyF") {
    e.preventDefault();
    must<HTMLInputElement>("#q").focus();
  } else if (e.key === "Enter" && (e.target as HTMLElement).closest("tr[data-id]")) {
    const tr = (e.target as HTMLElement).closest("tr[data-id]");
    if (tr instanceof HTMLElement && tr.dataset.id) openDoc(tr.dataset.id);
  }
}

async function load(): Promise<void> {
  const result = await api.home.get();
  const data = unwrap(result, "프로젝트 홈");
  if (!data) return;
  view = data;
  treeDocs = data.documents;
  setSidebarDocs(data.documents);
  sel = findDefaultDoc(data.documents) ?? data.documents[0]?.id ?? null;
  must("#tbTitle").textContent = data.project.title;
  must("#tbSub").textContent = `— ${shortPath(data.project.packagePath)} · 로컬 프로젝트`;
  must("#sbPath").textContent = shortPath(data.project.packagePath);
  setSelfTitle(`${data.project.title} — ${shortPath(data.project.packagePath)}`);
  renderSidebar(tree(), { currentDocId: sel });
  renderTable();
  renderProgress();
  renderUnc();
  renderRecentWork();
  renderAgents();
  void api.app.probeAgents().then((agents) => {
    if (view !== data) return;
    data.agents = agents;
    renderAgents();
  }).catch(() => undefined);
}

must("#q").addEventListener("input", renderTable);
must("#statusSel").addEventListener("change", renderTable);
must("#docBody").addEventListener("click", (e) => {
  const add = (e.target as HTMLElement).closest("[data-add-source]");
  if (add) {
    openNewSource();
    return;
  }
  const tr = (e.target as HTMLElement).closest("tr[data-id]");
  if (!(tr instanceof HTMLElement) || !tr.dataset.id) return;
  sel = tr.dataset.id;
  persistDoc(sel);
  renderTable();
});
must("#docBody").addEventListener("dblclick", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-id]");
  if (tr instanceof HTMLElement && tr.dataset.id) openDoc(tr.dataset.id);
});
must("#btnNewDoc").addEventListener("click", openNewSource);
must("#btnBackup").addEventListener("click", () => {
  void (async () => {
    const result = await api.project.backup();
    if (!result.ok) notify(result.error.message, "백업");
    else if (result.data) notify(`백업을 저장했습니다 · ${result.data}`, "백업");
  })();
});
must("#btnExport").addEventListener("click", openConfirmedExport);
must("#btnContinue").addEventListener("click", () => {
  const selected = view?.documents.find((d) => d.id === sel);
  if (selected && isSourceUnit(selected)) openDoc(selected.id);
  else openNewSource();
});
must("#uncAll").addEventListener("click", (e) => {
  e.preventDefault();
  location.href = "knowledge.html#uncertainty";
});

bindSidebar(
  (id) => {
    sel = id;
    persistDoc(id);
    renderTable();
    const d = view?.documents.find((x) => x.id === id);
    if (d && isSourceUnit(d)) openDoc(id);
  },
  undefined,
  tree,
  (parentId) => openNewDoc(parentId),
);

window.addEventListener("munhae:document-created", () => void load());
await load();
