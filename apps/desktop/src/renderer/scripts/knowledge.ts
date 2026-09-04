import type {
  DocumentListItem,
  GlossaryEntryView,
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
}).api;

let data: KnowledgeView = { glossary: [], persons: [], places: [], uncertainties: [], contextItems: [] };
let docs: DocumentListItem[] = [];
let tab: Tab = location.hash === "#uncertainty" ? "uncertainty" : location.hash === "#context" ? "context" : "glossary";
let active: string | null = null;
let selectedNodeId: string | null = null;

function tree() {
  return defaultSidebarTree(docs);
}

function stTag(st: GlossaryEntryView["usageStatus"]): string {
  const cls = st === "preferred" ? "tag-ok" : st === "forbidden" ? "tag-danger" : "tag-plain";
  return `<span class="tag ${cls}">${st}</span>`;
}

function setTab(t: Tab): void {
  tab = t;
  $$("#ktabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $$(".panel").forEach((p) => p.classList.toggle("is-open", p.id === `p-${t}`));
  const g = t === "glossary";
  must("#btnAdd").hidden = false;
  must("#q").hidden = t === "uncertainty" || t === "context";
  must("#statusSel").hidden = !g;
  must("#kindSel").hidden = !g;
  must("#btnAdd").textContent = t === "glossary" ? "용어 추가" : t === "persons" ? "인물 추가" : t === "places" ? "지명 추가" : "불확실성";
  if (t === "uncertainty" || t === "context") must("#btnAdd").hidden = true;
  must("#btnOpenDocument").hidden = t !== "context" || selectedNode()?.nodeRole !== "source_unit";
  must("#scopeNote").textContent = t === "context" ? contextScopeNote() : NOTES[t];
  renderSidebar(tree(), { currentDocId: t === "context" ? selectedNodeId : null, currentTab: t });
  if (t === "glossary") renderGlossary();
  if (t === "context") renderContext();
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
        `<tr data-cid="${esc(item.id)}" class="${active === item.id ? "is-active" : ""}" tabindex="0"><td><span class="tag ${item.distance === 0 ? "tag-ok" : "tag-plain"}">${esc(item.scopeLabel)}</span></td><td class="term">${esc(item.title)}</td><td class="mono muted" style="font-size:11.5px">${esc(item.itemKind)}</td><td class="mono">${item.priority}</td><td>${item.enabled ? '<span class="tag tag-ok">포함</span>' : '<span class="tag tag-plain">제외</span>'}</td></tr>`,
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
  must("#detail").innerHTML = `<div class="detail">
      <div class="term" style="font-size:16px">${esc(item.title)}</div>
      <div class="row" style="gap:6px"><span class="tag ${item.distance === 0 ? "tag-ok" : "tag-plain"}">${esc(item.scopeLabel)}</span><span class="tag tag-plain">${esc(item.itemKind)}</span></div>
      <p style="white-space:pre-wrap;line-height:1.65">${esc(item.contentMd)}</p>
      <dl class="kv"><dt>출처</dt><dd>${item.source === "document_description" ? "문서 설명" : "문맥 카드"}</dd><dt>우선순위</dt><dd class="mono">${item.priority}</dd><dt>AI 문맥</dt><dd>${item.enabled ? "자동 포함" : "자동 제외"}</dd></dl>
    </div>`;
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
      <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" id="dArchive" type="button">보관</button><button class="btn btn-primary btn-sm" id="dSave" type="button">저장 <kbd>⌘S</kbd></button></div>
    </div>`;
  must("#dSave").addEventListener("click", () => {
    void saveGlossary(g);
  });
  must("#dArchive").addEventListener("click", () => {
    notify("보관(삭제) API는 아직 없습니다. 항목은 유지됩니다", "용어집");
  });
}

async function saveGlossary(g: GlossaryEntryView): Promise<void> {
  const st = must<HTMLSelectElement>("#dSt").value as GlossaryEntryView["usageStatus"];
  if (
    st === "preferred" &&
    data.glossary.some((x) => x.id !== g.id && x.sourceTerm === g.sourceTerm && x.usageStatus === "preferred")
  ) {
    notify(`${g.sourceTerm}에는 이미 preferred 항목이 있습니다. 기존 항목을 allowed로 바꾼 뒤 저장하세요`, "저장 실패");
    return;
  }
  const result = await api.knowledge.upsertGlossary({
    id: g.id,
    sourceTerm: g.sourceTerm,
    targetTerm: must<HTMLInputElement>("#dTgt").value.trim() || g.targetTerm,
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
  must("#dSave").addEventListener("click", () => {
    void (async () => {
      const result = await api.knowledge.upsertPerson({
        id: p.id,
        preferredName: must<HTMLInputElement>("#dName").value.trim() || p.preferredName,
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
    })();
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
  must("#dSave").addEventListener("click", () => {
    void (async () => {
      const result = await api.knowledge.upsertPlace({
        id: p.id,
        preferredName: must<HTMLInputElement>("#dName").value.trim() || p.preferredName,
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
    })();
  });
}

function showUnc(u: UncertaintyView): void {
  active = u.id;
  renderOthers();
  must("#detailMeta").textContent = `${u.id.slice(0, 8)} · ${u.category} · ${u.severity}`;
  must("#sbSel").textContent = `${u.id.slice(0, 8)} ${u.state === "open" ? "열림" : "해결"}`;
  must("#detail").innerHTML = `<div class="detail">
      <b style="font-size:13px">${esc(u.statementMd)}</b>
      <div class="muted mono" style="font-size:11.5px">${esc(u.locator)}</div>
      <p class="muted">${u.blocking ? "확정 차단" : "비차단"} · ${esc(u.state)}</p>
      <div class="row" style="justify-content:flex-end">${u.state === "open" ? `<button class="btn btn-sm" id="uResolve" type="button">해결로 표시</button>` : '<span class="tag tag-ok">해결</span>'}</div>
    </div>`;
  $("#uResolve")?.addEventListener("click", () => {
    notify("불확실성 상태 변경 API는 아직 없습니다", "불확실성");
  });
}

function addFieldsHtml(): string {
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
          <label><input type="radio" name="st" value="forbidden"> forbidden <span class="muted">· Reflection에서 경고</span></label>
        </div>
      </div>
      <div class="field"><label for="aNote">메모</label><textarea class="textarea" id="aNote" placeholder="근거·출처·주의점"></textarea></div>`;
}

function openAdd(): void {
  if (tab === "uncertainty" || tab === "context") return;
  must("#addTitle").textContent = tab === "glossary" ? "용어 추가" : tab === "persons" ? "인물 추가" : "지명 추가";
  must("#addFields").innerHTML = addFieldsHtml();
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
      if (tab === "uncertainty" || tab === "context") setTab("glossary");
      openAdd();
      return true;
    case "find":
      must<HTMLInputElement>("#q").focus();
      return true;
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
    if (g) showGlossary(g);
  }
});
must("#pBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-pid]");
  if (tr instanceof HTMLElement && tr.dataset.pid) {
    const p = data.persons.find((x) => x.id === tr.dataset.pid);
    if (p) showPerson(p);
  }
});
must("#plBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-plid]");
  if (tr instanceof HTMLElement && tr.dataset.plid) {
    const p = data.places.find((x) => x.id === tr.dataset.plid);
    if (p) showPlace(p);
  }
});
must("#uBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-u]");
  if (tr instanceof HTMLElement && tr.dataset.u) {
    const u = data.uncertainties.find((x) => x.id === tr.dataset.u);
    if (u) showUnc(u);
  }
});
must("#cBody").addEventListener("click", (e) => {
  const tr = (e.target as HTMLElement).closest("tr[data-cid]");
  if (!(tr instanceof HTMLElement) || !tr.dataset.cid) return;
  const item = contextRows().find((candidate) => candidate.id === tr.dataset.cid);
  if (item) showContext(item);
});
must("#btnOpenDocument").addEventListener("click", () => {
  const node = selectedNode();
  if (node?.nodeRole === "source_unit") go("editor", node.id);
});
must("#btnAdd").addEventListener("click", openAdd);
must("#addCancel").addEventListener("click", () => (must("#dlgAdd") as HTMLDialogElement).close());
must<HTMLFormElement>("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  void (async () => {
    if (tab === "glossary") {
      const src = must<HTMLInputElement>("#aSrc").value.trim();
      const tgt = must<HTMLInputElement>("#aTgt").value.trim();
      const st = (document.querySelector('input[name="st"]:checked') as HTMLInputElement | null)?.value as
        | GlossaryEntryView["usageStatus"]
        | undefined;
      if (!src || !tgt) return;
      if (st === "preferred" && data.glossary.some((x) => x.sourceTerm === src && x.usageStatus === "preferred")) {
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
  })();
});
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.code === "KeyS" && $("#dSave")) {
    e.preventDefault();
    $("#dSave")?.click();
  }
});

bindSidebar(
  (id) => {
    selectedNodeId = id;
    active = null;
    setTab("context");
  },
  undefined,
  tree,
  undefined,
  { selectExpandable: true },
);

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

void boot();
