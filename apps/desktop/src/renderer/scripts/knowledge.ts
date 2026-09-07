import type {
  DocumentListItem,
  GlossaryEntryView,
  HomeView,
  KnowledgeView,
  NodeContextView,
  PersonView,
  PlaceView,
  UncertaintyView,
} from "../../shared/munhae-api";
import {
  $,
  $$,
  bindSidebar,
  defaultSidebarTree,
  esc,
  go,
  initShell,
  must,
  notify,
  renderSidebar,
  requireProject,
  setSelfTitle,
  shortPath,
  unwrap,
} from "./shared";

const project = await requireProject();
if (!project) throw new Error("redirect");

type Tab = "glossary" | "persons" | "places" | "uncertainty" | "context";
const TABS: readonly Tab[] = ["glossary", "persons", "places", "uncertainty", "context"];

const NOTES: Record<Tab, string> = {
  glossary: "프로젝트 공통 사전 · 현재 문서 원문과 정확히 일치할 때만 자동 적용",
  persons: "프로젝트 공통 사전 · 현재 문서의 일치 항목과 상속 저자만 자동 적용",
  places: "프로젝트 공통 사전 · 현재 문서 원문과 정확히 일치할 때만 자동 적용",
  uncertainty: "현재 문서의 node·번역 앵커와 연결된 열린 불확실성만 자동 적용",
  context: "사이드바에서 node를 선택하면 직접 연결된 문맥과 상속 문맥을 함께 보여줍니다",
};

const api = initShell({
  page: "knowledge",
  extraEnabled: ["ctxpane"],
  extraPalette: [
    { g: "공통 지식", l: "용어집 보기", k: "", id: "t-glossary" },
    { g: "공통 지식", l: "인물 보기", k: "", id: "t-persons" },
    { g: "공통 지식", l: "지명 보기", k: "", id: "t-places" },
    { g: "공통 지식", l: "불확실성 보기", k: "", id: "t-uncertainty" },
    { g: "공통 지식", l: "문서별 문맥 보기", k: "", id: "t-context" },
    { g: "공통 지식", l: "항목 추가…", k: "", id: "addterm" },
  ],
  selfTitle: `공통 지식 — ${project.title}`,
  pageCmd,
  pageKeys,
  beforeNavigate: () => {
    if (!canLeaveKnowledge()) return false;
    allowUnload = true;
    return true;
  },
  projectTransition: {
    before: () => canLeaveKnowledge(),
    committed: () => { allowUnload = true; },
  },
}).api;

let data: KnowledgeView = { glossary: [], persons: [], places: [], uncertainties: [], contextItems: [] };
let docs: DocumentListItem[] = [];
const requestedTab = location.hash.slice(1) as Tab;
let tab: Tab = TABS.includes(requestedTab) ? requestedTab : "glossary";
let active: string | null = null;
let selectedNodeId: string | null = null;
let detailBaseline = "";
let addBaseline = "";
let detailSaving = false;
let addSaving = false;
let allowUnload = false;

function formSnapshot(selector: string): string {
  return JSON.stringify($$<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    `${selector} input, ${selector} textarea, ${selector} select`,
  ).map((field) => [field.id || field.name, field.value, field instanceof HTMLInputElement ? field.checked : null]));
}

function detailIsDirty(): boolean {
  return detailBaseline !== "" && formSnapshot("#detail") !== detailBaseline;
}

function addIsDirty(): boolean {
  return must<HTMLDialogElement>("#dlgAdd").open && formSnapshot("#addFields") !== addBaseline;
}

function canLeaveKnowledge(): boolean {
  if (detailSaving || addSaving) {
    notify("작업을 마치는 중입니다. 잠시 뒤 다시 시도해 주세요.", "공통 지식");
    return false;
  }
  return (!detailIsDirty() && !addIsDirty())
    || window.confirm("저장하지 않은 변경이 있습니다. 변경을 버리고 이동하시겠습니까?");
}

function updateDetailState(): void {
  const status = $("#knowledgeSaveStatus");
  if (status) status.textContent = detailSaving ? "저장 중…" : detailIsDirty() ? "저장하지 않은 변경" : "저장됨";
  const save = $<HTMLButtonElement>("#dSave, #cSave, #uSave, #mSave");
  if (save) save.disabled = detailSaving || !detailIsDirty();
}

function trackDetail(): void {
  detailBaseline = formSnapshot("#detail");
  if ($("#dSave, #cSave, #uSave, #mSave")) {
    const status = document.createElement("p");
    status.id = "knowledgeSaveStatus";
    status.className = "knowledge-save-state";
    status.setAttribute("role", "status");
    must("#detail").append(status);
  }
  updateDetailState();
}

function clearDetail(): void {
  active = null;
  detailBaseline = "";
  must("#detailMeta").textContent = "행을 선택하세요";
  must("#sbSel").textContent = "";
  must("#detail").innerHTML = '<p class="muted">항목을 선택하면 내용을 보고 편집할 수 있습니다.</p>';
}

async function runDetailOperation(operation: () => Promise<void>): Promise<void> {
  if (detailSaving || addSaving) return;
  detailSaving = true;
  must("#detail").inert = true;
  must("#detail").setAttribute("aria-busy", "true");
  updateDetailState();
  try {
    await operation();
  } catch {
    notify("작업을 완료하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도해 주세요.", "공통 지식");
  } finally {
    detailSaving = false;
    must("#detail").inert = false;
    must("#detail").removeAttribute("aria-busy");
    updateDetailState();
  }
}

function tree() {
  return defaultSidebarTree(docs);
}

window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  renderSidebar(tree(), { currentDocId: selectedNodeId });
});

function stTag(st: GlossaryEntryView["usageStatus"]): string {
  const cls = st === "preferred" ? "tag-ok" : st === "forbidden" ? "tag-danger" : "tag-plain";
  return `<span class="tag ${cls}">${st}</span>`;
}

function setTab(t: Tab): void {
  if (!TABS.includes(t)) return;
  if (t !== tab) {
    if (!canLeaveKnowledge()) return;
    clearDetail();
  }
  tab = t;
  history.replaceState(history.state, "", `${location.pathname}${location.search}#${t}`);
  $$("#ktabs button").forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === t));
    b.setAttribute("aria-controls", `p-${b.dataset.tab}`);
    b.tabIndex = b.dataset.tab === t ? 0 : -1;
  });
  $$(".panel").forEach((p) => p.classList.toggle("is-open", p.id === `p-${t}`));
  const g = t === "glossary";
  must("#btnAdd").hidden = false;
  must("#q").hidden = t === "uncertainty" || t === "context";
  must("#statusSel").hidden = !g;
  must("#kindSel").hidden = !g;
  must("#btnAdd").textContent =
    t === "glossary" ? "용어 추가" :
      t === "persons" ? "인물 추가" :
        t === "places" ? "지명 추가" :
          t === "uncertainty" ? "불확실성 추가" : "문맥 카드 추가";
  must("#btnOpenDocument").hidden = t !== "context" || selectedNode()?.nodeRole !== "source_unit";
  must("#btnEditMetadata").hidden = t !== "context" || !selectedNode();
  must("#scopeNote").textContent = t === "context" ? contextScopeNote() : NOTES[t];
  renderSidebar(tree(), { currentDocId: t === "context" ? selectedNodeId : null, currentTab: t });
  if (t === "glossary") renderGlossary();
  if (t === "context") renderContext();
  if (t === "persons" || t === "places" || t === "uncertainty") renderOthers();
}

function renderGlossary(): void {
  const q = must<HTMLInputElement>("#q").value.trim();
  const st = must<HTMLSelectElement>("#statusSel").value;
  const kd = must<HTMLSelectElement>("#kindSel").value;
  const rows = data.glossary.filter(
    (g) =>
      (!q || g.sourceTerm.includes(q) || g.targetTerm.includes(q) || (g.reading ?? "").includes(q)) &&
      (!st || g.usageStatus === st) &&
      (!kd || g.termKind === kd),
  );
  must("#gBody").innerHTML =
    rows
      .map(
        (g) =>
          `<tr data-id="${esc(g.id)}" class="${active === g.id ? "is-active" : ""}" tabindex="0"><td class="term">${esc(g.sourceTerm)}</td><td>${esc(g.targetTerm)}</td><td class="mono muted" style="font-size:11.5px">${esc(g.termKind)}</td><td class="muted">${esc(g.reading ?? "")}</td><td>${stTag(g.usageStatus)}</td></tr>`,
      )
      .join("") || `<tr><td colspan="5" class="empty">일치하는 용어가 없습니다.</td></tr>`;
  must("#cntGlossary").textContent = String(data.glossary.length);
  must("#sbG").textContent = String(data.glossary.length);
}

function renderOthers(): void {
  const q = must<HTMLInputElement>("#q").value.trim();
  const persons = data.persons.filter(
    (p) => !q || p.preferredName.includes(q) || (p.hanjaName ?? "").includes(q) || p.aliases.some((a) => a.includes(q)),
  );
  const places = data.places.filter(
    (p) => !q || p.preferredName.includes(q) || (p.hanjaName ?? "").includes(q),
  );
  must("#pBody").innerHTML = persons
    .map(
      (p) =>
        `<tr data-pid="${esc(p.id)}" class="${active === p.id ? "is-active" : ""}" tabindex="0"><td class="term">${esc(p.hanjaName || p.preferredName)}</td><td>${esc(p.reading ?? p.preferredName)} <span class="muted">· ${esc(p.aliases.join(", ") || "—")}</span></td><td class="mono">${esc(p.dateText ?? "—")}</td><td class="muted">${esc(p.descriptionMd ?? "")}</td></tr>`,
    )
    .join("");
  must("#plBody").innerHTML = places
    .map(
      (p) =>
        `<tr data-plid="${esc(p.id)}" class="${active === p.id ? "is-active" : ""}" tabindex="0"><td class="term">${esc(p.hanjaName || p.preferredName)}</td><td>${esc(p.reading ?? "")}</td><td class="mono muted" style="font-size:11.5px">${esc(p.placeKind ?? "")}</td><td class="muted">${esc(p.locationNoteMd ?? p.descriptionMd ?? "")}</td></tr>`,
    )
    .join("");
  must("#uBody").innerHTML = data.uncertainties
    .map((u) => {
      const open = u.state === "open";
      return `<tr data-u="${esc(u.id)}" class="${active === u.id ? "is-active" : ""}" tabindex="0"><td class="mono">${esc(u.id.slice(0, 8))}</td><td>${esc(u.statementMd)}<div class="muted" style="font-size:12.5px;margin-top:2px">${esc(u.locator)}</div></td><td><span class="tag tag-warn">${esc(u.category)}</span></td><td class="mono muted" style="font-size:11.5px">${esc(u.locator)}</td><td>${open ? '<span class="tag tag-draft">열림</span>' : '<span class="tag tag-ok">해결</span>'}</td></tr>`;
    })
    .join("");
  must("#cntPersons").textContent = String(data.persons.length);
  must("#cntPlaces").textContent = String(data.places.length);
  must("#cntUnc").textContent = String(data.uncertainties.length);
  must("#sbP").textContent = String(data.persons.length);
  must("#sbPl").textContent = String(data.places.length);
  must("#sbU").textContent = String(data.uncertainties.filter((u) => u.state === "open").length);
  must("#sbC").textContent = String(data.contextItems.length);
}

type EffectiveContext = NodeContextView & { scopeLabel: string; distance: number };

function selectedNode(): DocumentListItem | undefined {
  return docs.find((document) => document.id === selectedNodeId);
}

function contextRows(): EffectiveContext[] {
  const distance = new Map<string, number>();
  let current = selectedNode();
  let d = 0;
  while (current && !distance.has(current.id)) {
    distance.set(current.id, d);
    current = current.parentId ? docs.find((document) => document.id === current!.parentId) : undefined;
    d += 1;
  }
  return data.contextItems
    .map((item): EffectiveContext | null => {
      const nodeDistance = distance.get(item.scopeId);
      if (nodeDistance === undefined) return null;
      const owner = docs.find((document) => document.id === item.scopeId);
      return {
        ...item,
        scopeLabel:
          nodeDistance === 0
            ? "현재 node"
            : `상위 ${nodeDistance} · ${owner?.originalTitle || owner?.title || "node"}`,
        distance: nodeDistance,
      };
    })
    .filter((item): item is EffectiveContext => item !== null)
    .sort((a, b) => a.distance - b.distance || b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt));
}

function contextScopeNote(): string {
  const node = selectedNode();
  if (!node) return NOTES.context;
  const role = node.nodeRole === "container" ? "목차 폴더" : "원문 문서";
  return `${node.originalTitle || node.title} · ${role} · 직접 문맥과 상속 문맥`;
}

function renderContext(): void {
  const rows = contextRows();
  must("#cBody").innerHTML = rows
    .map(
      (item) =>
        `<tr data-cid="${esc(item.id)}" class="${active === item.id ? "is-active" : ""}" tabindex="0"><td><span class="tag ${item.distance === 0 ? "tag-ok" : "tag-plain"}">${esc(item.scopeLabel)}</span></td><td class="term">${esc(item.title)}</td><td class="mono">${item.priority}</td><td>${item.enabled ? '<span class="tag tag-ok">포함</span>' : '<span class="tag tag-plain">제외</span>'}</td></tr>`,
    )
    .join("");
  must("#contextEmpty").hidden = rows.length > 0;
  must("#cntContext").textContent = String(rows.length);
  must("#scopeNote").textContent = contextScopeNote();
}

function showContext(item: EffectiveContext): void {
  active = item.id;
  renderContext();
  must("#detailMeta").textContent = item.scopeLabel;
  must("#sbSel").textContent = item.title;
  if (item.source === "document_description") {
    must("#detail").innerHTML = `<div class="detail">
        <div class="term" style="font-size:16px">${esc(item.title)}</div>
        <div class="row" style="gap:6px"><span class="tag ${item.distance === 0 ? "tag-ok" : "tag-plain"}">${esc(item.scopeLabel)}</span><span class="tag tag-plain">문서 설명</span></div>
        <p style="white-space:pre-wrap;line-height:1.65">${esc(item.contentMd)}</p>
        <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" id="dEditMetadata" type="button">문서 정보 편집</button></div>
      </div>`;
    trackDetail();
    must("#dEditMetadata").addEventListener("click", () => {
      if (canLeaveKnowledge()) void runDetailOperation(() => showDocumentMetadata(item.scopeId));
    });
    return;
  }
  must("#detail").innerHTML = `<div class="detail">
      <div class="row" style="gap:6px"><span class="tag ${item.distance === 0 ? "tag-ok" : "tag-plain"}">${esc(item.scopeLabel)}</span></div>
      <div class="field"><label for="cTitle">제목</label><input class="input" id="cTitle" value="${esc(item.title)}"></div>
      <div class="field"><label for="cContent">내용</label><textarea class="textarea" id="cContent" style="min-height:150px">${esc(item.contentMd)}</textarea></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="cPriority">우선순위</label><input class="input" type="number" id="cPriority" value="${item.priority}"></div>
      <label style="align-self:center"><input type="checkbox" id="cEnabled" ${item.enabled ? "checked" : ""}> AI 요청에 자동 포함</label></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" id="cArchive" type="button">보관</button><button class="btn btn-primary btn-sm" id="cSave" type="button">저장 <kbd>⌘S</kbd></button></div>
    </div>`;
  trackDetail();
  must("#cSave").addEventListener("click", () => void runDetailOperation(() => saveContext(item)));
  must("#cArchive").addEventListener("click", () => {
    if (!canLeaveKnowledge()) return;
    if (window.confirm(`‘${item.title}’ 문맥을 보관하시겠습니까? 앞으로의 AI 요청에서 제외됩니다.`)) {
      void runDetailOperation(() => archiveContext(item));
    }
  });
}

async function saveContext(item: EffectiveContext): Promise<void> {
  if (item.source !== "context_item") return;
  const result = await api.knowledge.updateContext({
    id: item.id,
    scopeId: item.scopeId,
    title: must<HTMLInputElement>("#cTitle").value.trim(),
    contentMd: must<HTMLTextAreaElement>("#cContent").value.trim(),
    priority: Number(must<HTMLInputElement>("#cPriority").value),
    enabled: must<HTMLInputElement>("#cEnabled").checked,
    expectedLockVersion: item.lockVersion,
  });
  const saved = unwrap(result, "문맥 카드");
  if (!saved) return;
  const index = data.contextItems.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) data.contextItems[index] = saved;
  renderContext();
  const effective = contextRows().find((candidate) => candidate.id === saved.id);
  if (effective) showContext(effective);
  notify(`${saved.title} 저장`, "문맥 카드");
}

async function archiveContext(item: EffectiveContext): Promise<void> {
  if (item.source !== "context_item") return;
  const result = await api.knowledge.archiveContext({ id: item.id, expectedLockVersion: item.lockVersion });
  if (!result.ok) {
    unwrap(result, "문맥 카드");
    return;
  }
  data.contextItems = data.contextItems.filter((candidate) => candidate.id !== item.id);
  clearDetail();
  renderContext();
  must("#detail").innerHTML = '<p class="muted">문맥을 보관했습니다. 이전 번역 작업의 기록은 유지됩니다.</p>';
  notify(`${item.title} 보관`, "문맥 카드");
}

async function showDocumentMetadata(nodeId: string): Promise<void> {
  const result = await api.home.getDocumentMetadata(nodeId);
  const metadata = unwrap(result, "문서 정보");
  if (!metadata) return;
  const authorOptions = [`<option value="">상속 또는 미지정</option>`, ...data.persons.map((person) =>
    `<option value="${esc(person.id)}" ${person.id === metadata.authorPersonId ? "selected" : ""}>${esc(person.preferredName)}</option>`,
  )].join("");
  must("#detailMeta").textContent = `문서 · ${metadata.lockVersion}`;
  must("#detail").innerHTML = `<div class="detail">
      <div class="field"><label for="mTitle">제목</label><input class="input" id="mTitle" value="${esc(metadata.title)}" ${metadata.isMaster ? "disabled" : ""}></div>
      <div class="field"><label for="mOriginal">원제</label><input class="input hanmun" id="mOriginal" value="${esc(metadata.originalTitle ?? "")}"></div>
      <div class="field"><label for="mAuthor">저자</label><select class="select" id="mAuthor">${authorOptions}</select></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="mLanguage">언어</label><input class="input" id="mLanguage" value="${esc(metadata.language ?? "")}"></div><div class="field" style="flex:1"><label for="mPeriod">시대</label><input class="input" id="mPeriod" value="${esc(metadata.periodText ?? "")}"></div></div>
      <div class="field"><label for="mDate">개별 날짜</label><input class="input" id="mDate" value="${esc(metadata.dateText ?? "")}"></div>
      <div class="field"><label for="mReference">출전</label><input class="input" id="mReference" value="${esc(metadata.sourceReference ?? "")}"></div>
      <div class="field"><label for="mDescription">설명</label><textarea class="textarea" id="mDescription">${esc(metadata.descriptionMd ?? "")}</textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" id="mSave" type="button">문서 정보 저장</button></div>
    </div>`;
  trackDetail();
  must("#mSave").addEventListener("click", () => void runDetailOperation(async () => {
    const save = await api.home.updateDocumentMetadata({
      documentNodeId: metadata.id,
      title: metadata.isMaster ? metadata.title : must<HTMLInputElement>("#mTitle").value.trim(),
      originalTitle: must<HTMLInputElement>("#mOriginal").value.trim() || null,
      authorPersonId: must<HTMLSelectElement>("#mAuthor").value || null,
      language: must<HTMLInputElement>("#mLanguage").value.trim() || null,
      periodText: must<HTMLInputElement>("#mPeriod").value.trim() || null,
      dateText: must<HTMLInputElement>("#mDate").value.trim() || null,
      sourceReference: must<HTMLInputElement>("#mReference").value.trim() || null,
      descriptionMd: must<HTMLTextAreaElement>("#mDescription").value.trim() || null,
      expectedLockVersion: metadata.lockVersion,
    });
    const saved = unwrap(save, "문서 정보");
    if (!saved) return;
    docs = docs.map((document) => document.id === saved.id
      ? { ...document, title: saved.title, originalTitle: saved.originalTitle }
      : document);
    renderSidebar(tree(), { currentDocId: selectedNodeId, currentTab: tab });
    const refreshed = await api.knowledge.get();
    const knowledge = unwrap(refreshed, "공통 지식");
    if (knowledge) data = knowledge;
    renderContext();
    await showDocumentMetadata(saved.id);
    notify(`${saved.title} 정보 저장`, "문서 정보");
  }));
}

function showGlossary(g: GlossaryEntryView): void {
  active = g.id;
  renderGlossary();
  must("#detailMeta").textContent = g.id.slice(0, 8);
  must("#sbSel").textContent = `${g.sourceTerm} → ${g.targetTerm}`;
  must("#detail").innerHTML = `<div class="detail">
      <div class="term" style="font-size:20px">${esc(g.sourceTerm)} <span class="muted" style="font-family:var(--font-ui);font-size:12px">${esc(g.reading ?? "")}</span></div>
      <div class="field"><label for="dTgt">번역 용어</label><input class="input" id="dTgt" value="${esc(g.targetTerm)}"></div>
      <div class="field"><label for="dSt">사용 상태</label><select class="select" id="dSt">${["preferred", "allowed", "forbidden"].map((s) => `<option ${g.usageStatus === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
      <div class="field"><label for="dNote">메모</label><textarea class="textarea" id="dNote">${esc(g.noteMd ?? "")}</textarea></div>
      <dl class="kv"><dt>종류</dt><dd class="mono">${esc(g.termKind)}</dd><dt>locale</dt><dd class="mono">${esc(g.targetLocale)}</dd></dl>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" id="dSave" type="button">저장 <kbd>⌘S</kbd></button></div>
    </div>`;
  trackDetail();
  must("#dSave").addEventListener("click", () => void runDetailOperation(() => saveGlossary(g)));
}

async function saveGlossary(g: GlossaryEntryView): Promise<void> {
  const target = must<HTMLInputElement>("#dTgt").value.trim();
  if (!target) {
    notify("번역 용어를 입력해 주세요.", "용어집");
    return;
  }
  const st = must<HTMLSelectElement>("#dSt").value as GlossaryEntryView["usageStatus"];
  if (
    st === "preferred" &&
    data.glossary.some((x) => x.id !== g.id && x.sourceTerm === g.sourceTerm && x.targetLocale === g.targetLocale && x.usageStatus === "preferred")
  ) {
    notify(`${g.sourceTerm}에는 이미 preferred 항목이 있습니다. 기존 항목을 allowed로 바꾼 뒤 저장하세요`, "저장 실패");
    return;
  }
  const result = await api.knowledge.upsertGlossary({
    id: g.id,
    expectedLockVersion: g.lockVersion,
    sourceTerm: g.sourceTerm,
    targetTerm: target,
    targetLocale: g.targetLocale,
    termKind: g.termKind,
    reading: g.reading,
    noteMd: must<HTMLTextAreaElement>("#dNote").value.trim() || null,
    usageStatus: st,
  });
  const saved = unwrap(result, "용어집");
  if (!saved) return;
  const i = data.glossary.findIndex((x) => x.id === g.id);
  if (i >= 0) data.glossary[i] = saved;
  notify(`${saved.sourceTerm} 저장`, "용어집");
  showGlossary(saved);
}

function showPerson(p: PersonView): void {
  active = p.id;
  renderOthers();
  must("#detailMeta").textContent = p.id.slice(0, 8);
  must("#sbSel").textContent = p.preferredName;
  must("#detail").innerHTML = `<div class="detail">
      <div class="term" style="font-size:20px">${esc(p.hanjaName || p.preferredName)}</div>
      <div class="field"><label for="dName">이름</label><input class="input" id="dName" value="${esc(p.preferredName)}"></div>
      <div class="field"><label for="dHanja">한자</label><input class="input hanmun" id="dHanja" value="${esc(p.hanjaName ?? "")}"></div>
      <div class="field"><label for="dRead">독음</label><input class="input" id="dRead" value="${esc(p.reading ?? "")}"></div>
      <div class="field"><label for="dAlias">별칭 (쉼표)</label><input class="input" id="dAlias" value="${esc(p.aliases.join(", "))}"></div>
      <div class="field"><label for="dDates">생몰</label><input class="input" id="dDates" value="${esc(p.dateText ?? "")}"></div>
      <div class="field"><label for="dDesc">설명</label><textarea class="textarea" id="dDesc">${esc(p.descriptionMd ?? "")}</textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" id="dSave" type="button">저장 <kbd>⌘S</kbd></button></div>
    </div>`;
  trackDetail();
  must("#dSave").addEventListener("click", () => {
    void runDetailOperation(async () => {
      const name = must<HTMLInputElement>("#dName").value.trim();
      if (!name) { notify("이름을 입력해 주세요.", "인물"); return; }
      const result = await api.knowledge.upsertPerson({
        id: p.id,
        expectedLockVersion: p.lockVersion,
        preferredName: name,
        hanjaName: must<HTMLInputElement>("#dHanja").value.trim() || null,
        reading: must<HTMLInputElement>("#dRead").value.trim() || null,
        aliases: must<HTMLInputElement>("#dAlias")
          .value.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        descriptionMd: must<HTMLTextAreaElement>("#dDesc").value.trim() || null,
        dateText: must<HTMLInputElement>("#dDates").value.trim() || null,
      });
      const saved = unwrap(result, "인물");
      if (!saved) return;
      const i = data.persons.findIndex((x) => x.id === p.id);
      if (i >= 0) data.persons[i] = saved;
      notify(`${saved.preferredName} 저장`, "인물");
      showPerson(saved);
    });
  });
}

function showPlace(p: PlaceView): void {
  active = p.id;
  renderOthers();
  must("#detailMeta").textContent = p.id.slice(0, 8);
  must("#sbSel").textContent = p.preferredName;
  must("#detail").innerHTML = `<div class="detail">
      <div class="term" style="font-size:20px">${esc(p.hanjaName || p.preferredName)}</div>
      <div class="field"><label for="dName">지명</label><input class="input" id="dName" value="${esc(p.preferredName)}"></div>
      <div class="field"><label for="dHanja">한자</label><input class="input hanmun" id="dHanja" value="${esc(p.hanjaName ?? "")}"></div>
      <div class="field"><label for="dRead">독음</label><input class="input" id="dRead" value="${esc(p.reading ?? "")}"></div>
      <div class="field"><label for="dKind">종류</label><input class="input" id="dKind" value="${esc(p.placeKind ?? "")}"></div>
      <div class="field"><label for="dLoc">위치</label><textarea class="textarea" id="dLoc">${esc(p.locationNoteMd ?? "")}</textarea></div>
      <div class="field"><label for="dDesc">설명</label><textarea class="textarea" id="dDesc">${esc(p.descriptionMd ?? "")}</textarea></div>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-primary btn-sm" id="dSave" type="button">저장 <kbd>⌘S</kbd></button></div>
    </div>`;
  trackDetail();
  must("#dSave").addEventListener("click", () => {
    void runDetailOperation(async () => {
      const name = must<HTMLInputElement>("#dName").value.trim();
      if (!name) { notify("지명을 입력해 주세요.", "지명"); return; }
      const result = await api.knowledge.upsertPlace({
        id: p.id,
        expectedLockVersion: p.lockVersion,
        preferredName: name,
        hanjaName: must<HTMLInputElement>("#dHanja").value.trim() || null,
        reading: must<HTMLInputElement>("#dRead").value.trim() || null,
        aliases: p.aliases,
        placeKind: must<HTMLInputElement>("#dKind").value.trim() || null,
        locationNoteMd: must<HTMLTextAreaElement>("#dLoc").value.trim() || null,
        descriptionMd: must<HTMLTextAreaElement>("#dDesc").value.trim() || null,
      });
      const saved = unwrap(result, "지명");
      if (!saved) return;
      const i = data.places.findIndex((x) => x.id === p.id);
      if (i >= 0) data.places[i] = saved;
      notify(`${saved.preferredName} 저장`, "지명");
      showPlace(saved);
    });
  });
}

function showUnc(u: UncertaintyView): void {
  active = u.id;
  renderOthers();
  must("#detailMeta").textContent = `${u.id.slice(0, 8)} · ${u.category} · ${u.severity}`;
  must("#sbSel").textContent = `${u.id.slice(0, 8)} ${u.state === "open" ? "열림" : "해결"}`;
  must("#detail").innerHTML = `<div class="detail">
      <div class="muted mono" style="font-size:11.5px">v${u.versionNo} · ${esc(u.locator)}</div>
      <div class="field"><label for="uStatement">진술</label><textarea class="textarea" id="uStatement">${esc(u.statementMd)}</textarea></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="uCategory">범주</label><select class="select" id="uCategory">${["textual", "interpretive", "identification"].map((value) => `<option ${value === u.category ? "selected" : ""}>${value}</option>`).join("")}</select></div><div class="field" style="flex:1"><label for="uSeverity">심각도</label><input class="input" id="uSeverity" value="${esc(u.severity)}"></div></div>
      <div class="field"><label for="uConfidence">확신도 표기</label><input class="input" id="uConfidence" value="${esc(u.confidenceLabel ?? "")}" placeholder="예: 확정, 유력, 미상"></div>
      <div class="field"><label for="uRationale">근거</label><textarea class="textarea" id="uRationale">${esc(u.rationaleMd ?? "")}</textarea></div>
      <div class="field"><label for="uOptions">해석 선택지 (한 줄에 하나)</label><textarea class="textarea" id="uOptions">${esc(u.options.map((option) => option.label).join("\n"))}</textarea></div>
      <label><input type="checkbox" id="uBlocking" ${u.blocking ? "checked" : ""}> 해결 전 번역 확정 차단</label>
      <div class="row" style="justify-content:flex-end">${u.state === "open" ? `<button class="btn btn-sm" id="uResolve" type="button">해결로 표시</button><button class="btn btn-primary btn-sm" id="uSave" type="button">새 버전 저장</button>` : '<span class="tag tag-ok">해결</span>'}</div>
    </div>`;
  if (u.state !== "open") {
    $$<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("#detail input, #detail textarea, #detail select")
      .forEach((field) => { field.disabled = true; });
  }
  trackDetail();
  $("#uResolve")?.addEventListener("click", () => {
    if (!canLeaveKnowledge()) return;
    void runDetailOperation(() => resolveUncertainty(u));
  });
  $("#uSave")?.addEventListener("click", () => void runDetailOperation(() => saveUncertaintyVersion(u)));
}

function replaceUncertainty(saved: UncertaintyView): void {
  const index = data.uncertainties.findIndex((item) => item.id === saved.id);
  if (index >= 0) data.uncertainties[index] = saved;
  else data.uncertainties.unshift(saved);
  renderOthers();
  showUnc(saved);
}

async function saveUncertaintyVersion(u: UncertaintyView): Promise<void> {
  const optionLabels = must<HTMLTextAreaElement>("#uOptions").value
    .split("\n")
    .map((label) => label.trim())
    .filter(Boolean);
  const result = await api.knowledge.versionUncertainty({
    uncertaintyId: u.id,
    expectedVersionId: u.versionId,
    category: must<HTMLSelectElement>("#uCategory").value as UncertaintyView["category"],
    severity: must<HTMLInputElement>("#uSeverity").value.trim(),
    blocking: must<HTMLInputElement>("#uBlocking").checked,
    statementMd: must<HTMLTextAreaElement>("#uStatement").value.trim(),
    rationaleMd: must<HTMLTextAreaElement>("#uRationale").value.trim() || null,
    confidenceLabel: must<HTMLInputElement>("#uConfidence").value.trim() || null,
    options: optionLabels.map((label, index) => ({
      label,
      interpretationMd: u.options[index]?.label === label ? u.options[index]?.interpretationMd : null,
    })),
    anchors: u.anchors.map((anchor) => ({
      targetKind: anchor.targetKind,
      targetVersionId: anchor.targetVersionId,
      codepointFrom: anchor.codepointFrom,
      codepointTo: anchor.codepointTo,
      quote: anchor.quote,
    })),
  });
  const saved = unwrap(result, "불확실성");
  if (!saved) return;
  replaceUncertainty(saved);
  notify(`v${saved.versionNo} 저장`, "불확실성");
}

async function resolveUncertainty(u: UncertaintyView): Promise<void> {
  const result = await api.knowledge.resolveUncertainty({ uncertaintyId: u.id, expectedVersionId: u.versionId });
  const saved = unwrap(result, "불확실성");
  if (!saved) return;
  replaceUncertainty(saved);
  notify("해결 상태로 변경했습니다", "불확실성");
}

function addFieldsHtml(): string {
  if (tab === "context") {
    return `<div class="field"><label for="aScope">적용 node</label><select class="select" id="aScope">${documentOptions(selectedNodeId)}</select></div>
      <div class="field"><label for="aTitle">제목</label><input class="input" id="aTitle" required></div>
      <div class="field"><label for="aNote">내용</label><textarea class="textarea" id="aNote" required></textarea></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="aPriority">우선순위</label><input class="input" id="aPriority" type="number" value="0"></div><label style="align-self:center"><input type="checkbox" id="aEnabled" checked> 자동 포함</label></div>`;
  }
  if (tab === "uncertainty") {
    return `<div class="field"><label for="aScope">연결 node</label><select class="select" id="aScope">${documentOptions(selectedNodeId)}</select></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="aCategory">범주</label><select class="select" id="aCategory"><option>textual</option><option>interpretive</option><option>identification</option></select></div><div class="field" style="flex:1"><label for="aSeverity">심각도</label><select class="select" id="aSeverity"><option>minor</option><option>major</option><option>critical</option></select></div></div>
      <div class="field"><label for="aStatement">진술</label><textarea class="textarea" id="aStatement" required></textarea></div>
      <div class="field"><label for="aConfidence">확신도 표기</label><input class="input" id="aConfidence" placeholder="예: 확정, 유력, 미상"></div>
      <div class="field"><label for="aNote">근거</label><textarea class="textarea" id="aNote"></textarea></div>
      <div class="field"><label for="aOptions">해석 선택지 (한 줄에 하나)</label><textarea class="textarea" id="aOptions"></textarea></div>
      <label><input type="checkbox" id="aBlocking"> 해결 전 번역 확정 차단</label>`;
  }
  if (tab === "persons") {
    return `<div class="field"><label for="aName">이름</label><input class="input" id="aName" required placeholder="예: 세종"></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="aHanja">한자</label><input class="input hanmun" id="aHanja" placeholder="世宗"></div>
      <div class="field" style="flex:1"><label for="aRead">독음</label><input class="input" id="aRead"></div></div>
      <div class="field"><label for="aDates">생몰</label><input class="input" id="aDates" placeholder="1397–1450"></div>
      <div class="field"><label for="aNote">설명</label><textarea class="textarea" id="aNote"></textarea></div>`;
  }
  if (tab === "places") {
    return `<div class="field"><label for="aName">지명</label><input class="input hanmun" id="aName" required placeholder="中國"></div>
      <div class="row" style="gap:10px"><div class="field" style="flex:1"><label for="aRead">독음</label><input class="input" id="aRead"></div>
      <div class="field" style="flex:1"><label for="aKind">종류</label><input class="input" id="aKind" placeholder="country"></div></div>
      <div class="field"><label for="aNote">위치·설명</label><textarea class="textarea" id="aNote"></textarea></div>`;
  }
  return `<div class="row" style="gap:10px;align-items:flex-start">
        <div class="field" style="flex:1"><label for="aSrc">원문 용어</label><input class="input hanmun" id="aSrc" required placeholder="例: 集賢殿" style="font-size:14px"></div>
        <div class="field" style="flex:1"><label for="aTgt">번역 용어</label><input class="input" id="aTgt" required placeholder="예: 집현전(集賢殿)"></div>
      </div>
      <div class="row" style="gap:10px;align-items:flex-start">
        <div class="field" style="flex:1"><label for="aKind">종류</label><select class="select" id="aKind"><option>general</option><option>technical</option><option>institution</option><option>office</option><option>book_title</option><option>era</option><option>other</option></select></div>
        <div class="field" style="flex:1"><label for="aRead">독음</label><input class="input" id="aRead" placeholder="예: 집현전"></div>
      </div>
      <div class="field"><label>사용 상태</label>
        <div class="radio-list">
          <label><input type="radio" name="st" value="preferred" checked> preferred <span class="muted">· 기본 대응어. 용어당 하나</span></label>
          <label><input type="radio" name="st" value="allowed"> allowed <span class="muted">· 문맥에 따라 허용</span></label>
          <label><input type="radio" name="st" value="forbidden"> forbidden <span class="muted">· 번역 검토에서 경고</span></label>
        </div>
      </div>
      <div class="field"><label for="aNote">메모</label><textarea class="textarea" id="aNote" placeholder="근거·출처·주의점"></textarea></div>`;
}

function documentOptions(selected: string | null): string {
  return docs.map((doc) => `<option value="${esc(doc.id)}" ${doc.id === selected ? "selected" : ""}>${esc(`${"  ".repeat(doc.depth)}${doc.originalTitle || doc.title}`)}</option>`).join("");
}

function openAdd(): void {
  if (!canLeaveKnowledge()) return;
  if (detailIsDirty()) clearDetail();
  must("#addTitle").textContent =
    tab === "glossary" ? "용어 추가" : tab === "persons" ? "인물 추가" : tab === "places" ? "지명 추가" : tab === "uncertainty" ? "불확실성 추가" : "문맥 카드 추가";
  must("#addFields").innerHTML = addFieldsHtml();
  addBaseline = formSnapshot("#addFields");
  (must("#dlgAdd") as HTMLDialogElement).showModal();
}

function pageCmd(id: string): boolean {
  if (id.startsWith("t-")) {
    setTab(id.slice(2) as Tab);
    return true;
  }
  switch (id) {
    case "ctxpane":
      return false;
    case "addterm":
      openAdd();
      return true;
    case "find":
      return false;
  }
  return false;
}

function pageKeys(e: KeyboardEvent, m: boolean): void {
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyF") {
    e.preventDefault();
    must<HTMLInputElement>("#q").focus();
  }
}

must("#ktabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b instanceof HTMLElement && b.dataset.tab) setTab(b.dataset.tab as Tab);
});
must("#ktabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = TABS.indexOf(tab);
  const next = event.key === "Home" ? TABS[0] : event.key === "End" ? TABS[TABS.length - 1]
    : TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
  if (!next) return;
  setTab(next);
  if (tab === next) $<HTMLButtonElement>(`#ktabs [data-tab="${next}"]`)?.focus();
});
["#q", "#statusSel", "#kindSel"].forEach((s) => {
  $(s)?.addEventListener("input", () => {
    renderGlossary();
    renderOthers();
  });
});
must("#gBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-id]");
  if (tr instanceof HTMLElement && tr.dataset.id) {
    const g = data.glossary.find((x) => x.id === tr.dataset.id);
    if (g && canLeaveKnowledge()) showGlossary(g);
  }
});
must("#pBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-pid]");
  if (tr instanceof HTMLElement && tr.dataset.pid) {
    const p = data.persons.find((x) => x.id === tr.dataset.pid);
    if (p && canLeaveKnowledge()) showPerson(p);
  }
});
must("#plBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-plid]");
  if (tr instanceof HTMLElement && tr.dataset.plid) {
    const p = data.places.find((x) => x.id === tr.dataset.plid);
    if (p && canLeaveKnowledge()) showPlace(p);
  }
});
must("#uBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-u]");
  if (tr instanceof HTMLElement && tr.dataset.u) {
    const u = data.uncertainties.find((x) => x.id === tr.dataset.u);
    if (u && canLeaveKnowledge()) showUnc(u);
  }
});
must("#cBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-cid]");
  if (!(tr instanceof HTMLElement) || !tr.dataset.cid) return;
  const item = contextRows().find((candidate) => candidate.id === tr.dataset.cid);
  if (item && canLeaveKnowledge()) showContext(item);
});
must("#btnOpenDocument").addEventListener("click", () => {
  const node = selectedNode();
  if (node?.nodeRole === "source_unit") go("editor", node.id);
});
must("#btnEditMetadata").addEventListener("click", () => {
  const node = selectedNode();
  if (node && canLeaveKnowledge()) void runDetailOperation(() => showDocumentMetadata(node.id));
});
must("#btnAdd").addEventListener("click", openAdd);
function canCloseAdd(): boolean {
  return !addSaving && (!addIsDirty() || window.confirm("입력한 내용을 버리고 닫으시겠습니까?"));
}
must("#addCancel").addEventListener("click", () => {
  if (canCloseAdd()) must<HTMLDialogElement>("#dlgAdd").close();
});
must<HTMLDialogElement>("#dlgAdd").addEventListener("cancel", (event) => {
  if (!canCloseAdd()) event.preventDefault();
});
must<HTMLFormElement>("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (addSaving || detailSaving) return;
  addSaving = true;
  must("#addForm").inert = true;
  must("#addForm").setAttribute("aria-busy", "true");
  void (async () => {
    if (tab === "context") {
      const result = await api.knowledge.createContext({
        scopeId: must<HTMLSelectElement>("#aScope").value,
        title: must<HTMLInputElement>("#aTitle").value.trim(),
        contentMd: must<HTMLTextAreaElement>("#aNote").value.trim(),
        priority: Number(must<HTMLInputElement>("#aPriority").value),
        enabled: must<HTMLInputElement>("#aEnabled").checked,
      });
      const saved = unwrap(result, "문맥 카드");
      if (!saved) return;
      data.contextItems.push(saved);
      selectedNodeId = saved.scopeId;
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderContext();
      const effective = contextRows().find((item) => item.id === saved.id);
      if (effective) showContext(effective);
      notify(`${saved.title} 추가`, "문맥 카드");
      return;
    }
    if (tab === "uncertainty") {
      const scopeId = must<HTMLSelectElement>("#aScope").value;
      const result = await api.knowledge.createUncertainty({
        category: must<HTMLSelectElement>("#aCategory").value as UncertaintyView["category"],
        severity: must<HTMLSelectElement>("#aSeverity").value,
        blocking: must<HTMLInputElement>("#aBlocking").checked,
        statementMd: must<HTMLTextAreaElement>("#aStatement").value.trim(),
        rationaleMd: must<HTMLTextAreaElement>("#aNote").value.trim() || null,
        confidenceLabel: must<HTMLInputElement>("#aConfidence").value.trim() || null,
        options: must<HTMLTextAreaElement>("#aOptions").value.split("\n").map((label) => label.trim()).filter(Boolean).map((label) => ({ label })),
        anchors: [{ targetKind: "document_node", targetVersionId: scopeId }],
      });
      const saved = unwrap(result, "불확실성");
      if (!saved) return;
      data.uncertainties.unshift(saved);
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderOthers();
      showUnc(saved);
      notify("불확실성 추가", "불확실성");
      return;
    }
    if (tab === "glossary") {
      const src = must<HTMLInputElement>("#aSrc").value.trim();
      const tgt = must<HTMLInputElement>("#aTgt").value.trim();
      const st = (document.querySelector('input[name="st"]:checked') as HTMLInputElement | null)?.value as
        | GlossaryEntryView["usageStatus"]
        | undefined;
      if (!src || !tgt) return;
      if (st === "preferred" && data.glossary.some((x) => x.sourceTerm === src && x.targetLocale === "ko" && x.usageStatus === "preferred")) {
        notify(`${src}에는 이미 preferred 항목이 있습니다 (unique 제약)`, "추가 실패");
        return;
      }
      const result = await api.knowledge.upsertGlossary({
        sourceTerm: src,
        targetTerm: tgt,
        targetLocale: "ko",
        termKind: must<HTMLSelectElement>("#aKind").value,
        reading: must<HTMLInputElement>("#aRead").value.trim() || null,
        noteMd: must<HTMLTextAreaElement>("#aNote").value.trim() || null,
        usageStatus: st ?? "preferred",
      });
      const saved = unwrap(result, "용어집");
      if (!saved) return;
      data.glossary.unshift(saved);
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderGlossary();
      renderSidebar(tree(), { currentTab: tab });
      showGlossary(saved);
      notify(`${src} → ${tgt} 추가`, "용어집");
      return;
    }
    if (tab === "persons") {
      const name = must<HTMLInputElement>("#aName").value.trim();
      if (!name) return;
      const result = await api.knowledge.upsertPerson({
        preferredName: name,
        hanjaName: ($("#aHanja") as HTMLInputElement | null)?.value.trim() || null,
        reading: ($("#aRead") as HTMLInputElement | null)?.value.trim() || null,
        aliases: [],
        descriptionMd: ($("#aNote") as HTMLTextAreaElement | null)?.value.trim() || null,
        dateText: ($("#aDates") as HTMLInputElement | null)?.value.trim() || null,
      });
      const saved = unwrap(result, "인물");
      if (!saved) return;
      data.persons.unshift(saved);
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderOthers();
      setTab("persons");
      showPerson(saved);
      notify(`${name} 추가`, "인물");
      return;
    }
    if (tab === "places") {
      const name = must<HTMLInputElement>("#aName").value.trim();
      if (!name) return;
      const result = await api.knowledge.upsertPlace({
        preferredName: name,
        hanjaName: name,
        reading: ($("#aRead") as HTMLInputElement | null)?.value.trim() || null,
        aliases: [],
        placeKind: ($("#aKind") as HTMLInputElement | null)?.value.trim() || null,
        locationNoteMd: ($("#aNote") as HTMLTextAreaElement | null)?.value.trim() || null,
        descriptionMd: null,
      });
      const saved = unwrap(result, "지명");
      if (!saved) return;
      data.places.unshift(saved);
      (must("#dlgAdd") as HTMLDialogElement).close();
      renderOthers();
      setTab("places");
      showPlace(saved);
      notify(`${name} 추가`, "지명");
    }
  })().catch(() => {
    notify("항목을 추가하지 못했습니다. 입력한 내용은 유지됩니다. 다시 시도해 주세요.", "공통 지식");
  }).finally(() => {
    addSaving = false;
    must("#addForm").inert = false;
    must("#addForm").removeAttribute("aria-busy");
  });
});
document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.code !== "KeyS") return;
  if (must<HTMLDialogElement>("#dlgAdd").open) {
    e.preventDefault();
    if (!addSaving) must<HTMLFormElement>("#addForm").requestSubmit();
    return;
  }
  const save = $("#dSave") ?? $("#cSave") ?? $("#uSave") ?? $("#mSave");
  if (!save) return;
  e.preventDefault();
  save.click();
});

bindSidebar(
  (id) => {
    if (!canLeaveKnowledge()) return;
    clearDetail();
    selectedNodeId = id;
    setTab("context");
  },
  (nextTab) => setTab(nextTab as Tab),
  tree,
  undefined,
  { selectExpandable: true },
);

must("#detail").addEventListener("input", updateDetailState);
must("#detail").addEventListener("change", updateDetailState);
for (const selector of ["#gBody", "#pBody", "#plBody", "#uBody", "#cBody"]) {
  must(selector).addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("tr[tabindex]");
    if (!row) return;
    event.preventDefault();
    row.click();
  });
}
window.addEventListener("beforeunload", (event) => {
  if (!allowUnload && (detailSaving || addSaving || detailIsDirty() || addIsDirty())) {
    event.preventDefault();
    event.returnValue = "";
  }
});

async function boot(): Promise<void> {
  const home = await api.home.get();
  if (home.ok) {
    docs = home.data.documents;
    const requestedNodeId = new URLSearchParams(location.search).get("node");
    selectedNodeId = docs.some((document) => document.id === requestedNodeId) ? requestedNodeId : docs[0]?.id ?? null;
    setSelfTitle(`공통 지식 — ${home.data.project.title}`);
    const path = $("#sbPath");
    if (path) path.textContent = shortPath(home.data.project.packagePath);
  } else {
    const path = $("#sbPath");
    if (path) path.textContent = shortPath(project?.packagePath ?? "");
  }
  const result = await api.knowledge.get();
  const v = unwrap(result, "공통 지식");
  if (v) data = v;
  renderGlossary();
  renderOthers();
  setTab(tab);
}

await boot();
