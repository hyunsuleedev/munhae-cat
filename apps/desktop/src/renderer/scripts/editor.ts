import type { ContextPreview, DocumentListItem, EditorView, KnowledgeView } from "../../shared/munhae-api";
import {
  $,
  $$,
  bindSidebar,
  defaultSidebarTree,
  esc,
  findDefaultDoc,
  go,
  ic,
  initShell,
  must,
  notify,
  nowHM,
  persistDoc,
  readPersistedDoc,
  renderSidebar,
  requireProject,
  setSelfTitle,
  shortPath,
  store,
  unwrap,
} from "./shared";

const project = await requireProject();
if (!project) throw new Error("redirect");

type Layout = "source" | "parallel" | "full";
type Block = {
  key: string;
  anchors: string[];
  text: string;
  kind: string;
};

type TermInfo = { target: string; kind: string; status: string; note: string };

const api = initShell({
  page: "editor",
  extraEnabled: [
    "refpane",
    "ctxpane",
    "v-source",
    "v-parallel",
    "v-full",
    "struct",
    "keys",
    "reflect",
    "merge",
    "split",
    "link",
    "diff",
    "confirm",
    "prepare",
    "run",
  ],
  selfTitle: `편집 — ${project.title}`,
  pageCmd,
  pageKeys,
}).api;

let docs: DocumentListItem[] = [];
let view: EditorView | null = null;
let layout: Layout = "parallel";
let stage = "";
let viewingKey = "";
let editingKey = "";
let blocks: Block[] = [];
let dirty = false;
let active: string | null = null;
let hot: string[] = [];
let activeFinding: number | null = null;
let page = 1;
const PAGES = 4;
let terms: Record<string, TermInfo> = {};
let knowledge: KnowledgeView | null = null;
let splitIdx: number | null = null;
let linkIdx: number | null = null;
let cmIdx: number | null = null;
let prepPreview: ContextPreview | null = null;
let prepDocId: string | null = null;
let prepRequest = 0;
const prepAuxMode = new Map<string, "auto" | "pin" | "exclude">();

function tree() {
  return defaultSidebarTree(docs);
}

function cand(v: EditorView, key?: string): EditorView["candidates"][number] | undefined {
  if (key) return v.candidates.find((c) => c.candidateKey === key);
  return (
    v.candidates.find((c) => c.isCurrent) ??
    v.candidates.find((c) => c.stage === v.activeStage) ??
    v.candidates[0]
  );
}

function stagesOf(v: EditorView): string[] {
  const out: string[] = [];
  for (const c of v.candidates) {
    if (!out.includes(c.stage)) out.push(c.stage);
  }
  return out;
}

function stageLabel(s: string): string {
  if (s === "literal") return "직역안";
  if (s === "reader") return "독자안";
  return s;
}

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

function prepReasonLabel(reason: string): string {
  if (reason === "current_document" || reason === "current_document_context") return "현재 문서";
  if (reason.startsWith("ancestor_document_context:")) {
    return `상위 문서 · ${reason.split(":")[1]}단계`;
  }
  const labels: Record<string, string> = {
    exact_match: "원문 일치",
    related_uncertainty: "현재 문서 앵커",
    project_uncertainty: "다른 문서의 불확실성",
    project_glossary: "공통 용어집",
    project_person: "공통 인물",
    project_place: "공통 지명",
  };
  return labels[reason] ?? reason;
}

function selectedPrepRecipe(): "two_step" | "three_step" {
  return must<HTMLSelectElement>("#prepRecipe").value === "3" ? "three_step" : "two_step";
}

function renderPreparation(): void {
  if (!view || !prepPreview) return;
  const title = view.document.originalTitle || view.document.title;
  const reqChars = prepPreview.required.reduce((sum, item) => sum + item.chars, 0);
  const auxChars = prepPreview.auxiliary
    .filter((item) => item.included)
    .reduce((sum, item) => sum + item.chars, 0);
  const agent = must<HTMLSelectElement>("#prepAgent").value;
  const agentLabel = agent === "codex" ? "Codex CLI" : "Claude CLI";

  must("#prepTitle").textContent = `${title}의 전체 표점 원문과 선택한 보조 자료를 함께 보냅니다.`;
  must("#prepTotal").textContent = `${fmt(prepPreview.characterCount)}자 · ${fmt(prepPreview.utf8ByteCount)} B`;
  must("#prepRequired").innerHTML = prepPreview.required
    .map((item) => {
      const detail = [item.kind, item.version, item.hash].filter(Boolean).join(" · ");
      return `<div class="prep-item"><div class="prep-item-main"><b>${esc(item.label)}</b><div class="prep-item-sub">${esc(detail)}</div></div><div class="prep-item-count">${fmt(item.chars)}자</div><span class="prep-lock">필수</span></div>`;
    })
    .join("");
  must("#prepAux").innerHTML = prepPreview.auxiliary
    .map((item) => {
      const mode = prepAuxMode.get(item.id) ?? item.selection;
      return `<div class="prep-item${item.included ? "" : " is-off"}"><div class="prep-item-main"><b>${esc(item.label)}</b><div class="prep-item-sub">${esc(item.kind)} · ${esc(prepReasonLabel(item.reason))} · ${item.included ? "전송" : "미전송"}</div></div><div class="prep-item-count">${item.chars ? `${fmt(item.chars)}자` : "—"}</div>${item.chars ? `<div class="seg prep-choice" role="group" aria-label="${esc(item.label)} 전송 방식" data-prep-id="${esc(item.id)}">${(["auto", "pin", "exclude"] as const).map((modeId) => `<button type="button" data-prep-mode="${modeId}" aria-pressed="${mode === modeId}">${{ auto: "자동", pin: "고정", exclude: "제외" }[modeId]}</button>`).join("")}</div>` : '<span class="prep-lock">해당 없음</span>'}</div>`;
    })
    .join("");
  must("#prepStatus").className = "tag tag-ok";
  must("#prepStatus").textContent = "준비됨";
  must("#prepBudget").innerHTML = `<dt>문서</dt><dd class="hanmun">${esc(title)}</dd><dt>필수 입력</dt><dd>${fmt(reqChars)}자</dd><dt>보조 자료</dt><dd>${fmt(auxChars)}자</dd><dt class="prep-total">실제 요청</dt><dd class="prep-total">${fmt(prepPreview.characterCount)}자<br>${fmt(prepPreview.utf8ByteCount)} B</dd>`;
  must("#prepNote").textContent = "전송 자료는 준비됐습니다. 로컬 CLI 실행 연결은 아직 구현되지 않았습니다.";
  must("#prepRun").textContent = `번역 실행 — ${agentLabel}`;
  (must("#prepRun") as HTMLButtonElement).disabled = true;
  try {
    must("#prepManifest").textContent = JSON.stringify(JSON.parse(prepPreview.manifestJson) as unknown, null, 2);
  } catch {
    must("#prepManifest").textContent = prepPreview.manifestJson;
  }
  must("#prepManifestHash").textContent = `sha256 ${prepPreview.manifestHash.slice(0, 12)}…`;
}

function showPreparationLoading(): void {
  prepPreview = null;
  must("#prepRequired").innerHTML = '<p class="muted">필수 입력을 불러오는 중입니다.</p>';
  must("#prepAux").innerHTML = '<p class="muted">보조 자료를 불러오는 중입니다.</p>';
  must("#prepTotal").textContent = "전송 자료 계산 중";
  must("#prepStatus").className = "tag tag-plain";
  must("#prepStatus").textContent = "계산 중";
  must("#prepBudget").innerHTML = "";
  must("#prepNote").textContent = "현재 문서의 exact request를 조립하고 있습니다.";
  must("#prepManifest").textContent = "";
  must("#prepManifestHash").textContent = "";
}

async function loadPreparation(preserveSelections = false): Promise<void> {
  if (!view) return;
  const documentNodeId = view.document.id;
  const request = ++prepRequest;
  if (!preserveSelections || prepDocId !== documentNodeId) prepAuxMode.clear();
  prepDocId = documentNodeId;
  showPreparationLoading();
  const result = await api.context.preview({
    documentNodeId,
    recipe: selectedPrepRecipe(),
    selections: [...prepAuxMode].map(([id, mode]) => ({ id, mode })),
  });
  if (request !== prepRequest) return;
  if (!result.ok) {
    must("#prepStatus").className = "tag tag-warn";
    must("#prepStatus").textContent = "확인 필요";
    must("#prepNote").textContent = result.error.message;
    must("#prepTotal").textContent = "전송 자료를 만들 수 없음";
    notify(result.error.message, "AI 번역");
    return;
  }
  prepPreview = result.data;
  prepAuxMode.clear();
  for (const item of result.data.auxiliary) prepAuxMode.set(item.id, item.selection);
  renderPreparation();
}

function openPreparation(): void {
  if (!view || (!view.source.contentText && !view.punctuation.punctuatedText)) {
    notify("AI 번역을 실행하려면 이 문서에 원문이 있어야 합니다", "AI 번역");
    return;
  }
  const dialog = must("#dlgPrepare") as HTMLDialogElement;
  if (!dialog.open) dialog.showModal();
  void loadPreparation(prepDocId === view.document.id);
}

function blocksFrom(c: EditorView["candidates"][number]): Block[] {
  return c.blocks.map((b) => ({
    key: b.blockKey,
    anchors: [...b.sourceAnchorIds],
    text: b.translation,
    kind: b.blockKind,
  }));
}

function joinBlocks(bs: Block[]): string {
  return bs.map((b) => b.text).join(" ");
}

function viewing(): EditorView["candidates"][number] | undefined {
  return view ? cand(view, viewingKey) : undefined;
}

function editing(): boolean {
  return !!view && viewingKey === editingKey && viewing()?.state !== "confirmed";
}

function shownBlocks(): Block[] {
  if (viewingKey === editingKey) return blocks;
  const c = viewing();
  return c ? blocksFrom(c) : blocks;
}

function markTerms(text: string): string {
  let html = esc(text);
  const keys = Object.keys(terms).sort((a, b) => b.length - a.length);
  for (const t of keys) {
    html = html.split(t).join(`<span class="term" data-term="${esc(t)}">${esc(t)}</span>`);
  }
  return html;
}

function validate(bs: Block[]): string[] {
  const issues: string[] = [];
  if (!view) return issues;
  const order = view.anchors.map((a) => a.anchorKey);
  const seen: Record<string, number> = {};
  let last = -1;
  bs.forEach((b, i) => {
    if (!b.text.trim()) issues.push(`${b.key} 번역이 비어 있음 (empty_block)`);
    if (!b.anchors.length) issues.push(`${b.key} 연결 앵커 없음 (missing_coverage)`);
    const idx = b.anchors.map((k) => order.indexOf(k));
    for (let j = 1; j < idx.length; j++) {
      const prev = idx[j - 1];
      const cur = idx[j];
      if (prev !== undefined && cur !== undefined && cur !== prev + 1) {
        issues.push(`${b.key} 앵커가 연속하지 않음 (noncontiguous_anchors)`);
        break;
      }
    }
    const first = idx[0];
    if (first !== undefined && first < last) issues.push(`${b.key} 앵커 순서 역행 (anchor_order)`);
    b.anchors.forEach((k) => {
      if (seen[k] !== undefined) issues.push(`${k} 중복 연결 (duplicate_anchor)`);
      seen[k] = i;
    });
    if (idx.length) last = Math.max(last, ...idx);
  });
  order.forEach((k) => {
    if (seen[k] === undefined) issues.push(`${k} 어느 블록에도 연결되지 않음 (missing_coverage)`);
  });
  return issues;
}

function quoteFor(key: string): string {
  const a = view?.anchors.find((x) => x.anchorKey === key);
  if (a?.punctuatedQuote) return a.punctuatedQuote;
  if (a && view?.punctuation.punctuatedText) {
    return Array.from(view.punctuation.punctuatedText)
      .slice(a.punctuationFrom, a.punctuationTo)
      .join("");
  }
  return "";
}

function renderSource(): void {
  if (!view) return;
  const parts: string[] = ['<span class="struct-label">¶1 paragraph</span>'];
  let lastSent = 0;
  view.anchors.forEach((a, i) => {
    const sent = Math.max(1, Math.ceil((i + 1) / Math.max(1, Math.ceil(view!.anchors.length / 2))));
    if (sent !== lastSent) {
      lastSent = sent;
      parts.push(`<span class="struct-label">S${sent} sentence</span>`);
    }
    const hotCls = hot.includes(a.anchorKey) ? " is-hot" : "";
    parts.push(
      `<span class="anchor${hotCls}" data-key="${esc(a.anchorKey)}" tabindex="0"><sup class="anchor-key">${esc(a.anchorKey)}</sup>${markTerms(quoteFor(a.anchorKey))}</span>`,
    );
  });
  if (!view.anchors.length) {
    parts.push(markTerms(view.punctuation.punctuatedText || view.source.contentText));
  }
  must("#sourceText").innerHTML = parts.join("");
}

function renderRows(): void {
  const bs = shownBlocks();
  const can = editing();
  must("#rows").innerHTML = bs
    .map((b, i) => {
      const isHot = b.anchors.some((k) => hot.includes(k));
      const src = b.anchors.map((k) => quoteFor(k)).join("");
      return `<article class="brow${active === b.key ? " is-active" : ""}${isHot ? " is-hot" : ""}" data-key="${esc(b.key)}" data-i="${i}">
      <div class="bcell bcell-src"><div class="bmeta"><span class="bkey">${esc(b.key)}</span>${b.anchors.map((k) => `<span class="akey${hot.includes(k) ? " is-hot" : ""}" data-akey="${esc(k)}">${esc(k)}</span>`).join("")}</div><div>${markTerms(src)}</div></div>
      <div class="bcell bcell-tgt"><div class="bmeta"><span class="tag tag-plain">${esc(b.kind || "paragraph")}</span>${can ? "" : '<span class="tag tag-line">읽기 전용</span>'}<span class="sp"></span><button class="more" data-more="${i}" type="button" aria-label="블록 동작 메뉴" title="블록 동작 (우클릭)">⋯</button></div>
        <div class="tgt-edit" contenteditable="${can}" spellcheck="false" data-edit="${esc(b.key)}">${esc(b.text)}</div></div>
    </article>`;
    })
    .join("");
  must("#blockCount").textContent = String(bs.length);
}

function renderFull(): void {
  must("#fullText").innerHTML = shownBlocks()
    .map(
      (b) =>
        `<span class="blk${b.anchors.some((k) => hot.includes(k)) ? " is-hot" : ""}" data-key="${esc(b.key)}">${esc(b.text)}</span>`,
    )
    .join(" ");
}

function renderStrip(): void {
  const bs = shownBlocks();
  const issues = validate(bs);
  const ok = issues.length === 0;
  const isCand = viewingKey !== editingKey;
  const vs = must("#vstrip");
  vs.classList.toggle("is-bad", !ok);
  const c = viewing();
  vs.innerHTML = ok
    ? `<span class="tag tag-ok">valid</span><span>앵커 ${view?.anchors.length ?? 0}/${view?.anchors.length ?? 0} 연결</span><i class="sep"></i><span>순서·연속성 정상</span><i class="sep"></i><span class="muted">블록 ${bs.length}개 · ${isCand ? "AI 제안 원본" : `v${c?.versionNo ?? ""}`}</span>`
    : `<span class="tag tag-warn">needs_review</span><span>${issues.length}건 — ${esc(issues[0] ?? "")}${issues.length > 1 ? " 외" : ""}</span><i class="sep"></i><span class="muted">연결을 고쳐 새 valid 번역안을 만들기 전에는 확정할 수 없습니다</span>`;
  const sb = must("#stateBadge");
  const vb = must("#validBadge");
  let label: string;
  const confirmed = c?.isConfirmed || c?.state === "confirmed";
  if (isCand) {
    sb.className = "tag tag-line";
    label = `AI 제안 · ${stageLabel(c?.stage ?? stage)}`;
  } else if (confirmed) {
    sb.className = "tag tag-ok";
    label = `확정 v${c?.versionNo ?? ""}`;
  } else {
    sb.className = "tag tag-draft";
    label = `번역안 v${c?.versionNo ?? ""}`;
  }
  sb.textContent = label;
  vb.className = ok ? "tag tag-plain" : "tag tag-warn";
  vb.textContent = ok ? "valid" : "needs_review";
  const docTitle = view?.document.originalTitle || view?.document.title || "문서";
  must("#titleDoc").textContent = docTitle;
  must("#titleSub").textContent = `— ${label}`;
  document.title = `${docTitle} — 문해 Munhae Studio`;
  must("#sbValid").innerHTML = `<span class="tag ${ok ? "tag-ok" : "tag-warn"}" style="height:16px;font-size:10.5px">${ok ? "valid" : "needs_review"}</span> 블록 ${bs.length}`;
  const bc = must<HTMLButtonElement>("#btnConfirm");
  const br = must<HTMLButtonElement>("#btnRevise");
  bc.hidden = !!(confirmed && !isCand);
  br.hidden = !(confirmed && !isCand);
  bc.disabled = !ok || isCand;
  bc.title = isCand
    ? "AI 제안은 채택한 뒤 확정할 수 있습니다"
    : !ok
      ? "needs_review 상태에서는 확정할 수 없습니다"
      : "번역안 확정 (⇧⌘↩)";
  must("#candBanner").hidden = !isCand;
  if (isCand) {
    must("#candBannerText").textContent = `${stageLabel(c?.stage ?? "")} — 읽기 전용입니다. 채택하면 편집 기반이 됩니다.`;
  }
  renderCandSeg();
}

function renderCandSeg(): void {
  if (!view) return;
  const box = must("#candSeg");
  const st = stagesOf(view);
  box.innerHTML = st
    .map((s) => {
      const cur = view!.candidates.find((c) => c.stage === s && c.isCurrent) ?? view!.candidates.find((c) => c.stage === s);
      const pressed = cur?.candidateKey === viewingKey || (cur && cur.stage === stage && viewingKey === cur.candidateKey);
      const isEdit = cur?.candidateKey === editingKey;
      const small = isEdit ? (cur?.isConfirmed || cur?.state === "confirmed" ? "확정" : "편집 중") : "AI 제안";
      return `<button type="button" data-cand="${esc(cur?.candidateKey ?? s)}" data-stage="${esc(s)}" aria-pressed="${pressed}">${esc(stageLabel(s))} <small>${small}</small></button>`;
    })
    .join("");
}

function renderHistory(): void {
  if (!view) return;
  const items = [...view.candidates].sort((a, b) => b.versionNo - a.versionNo);
  must("#histList").innerHTML = items
    .map((h) => {
      const confirmed = h.isConfirmed || h.state === "confirmed";
      const cls = confirmed ? "tag-ok" : h.originKind.includes("ai") || h.originKind.includes("agent") ? "tag-line" : "tag-draft";
      const label = confirmed ? "확정" : h.originKind.includes("ai") || h.originKind.includes("agent") ? "AI 제안" : "번역안";
      return `<div class="hist-item"><span class="v">v${h.versionNo}</span><div><div class="row" style="gap:6px;flex-wrap:wrap"><span class="tag ${cls}">${label}</span><b>${esc(stageLabel(h.stage))}</b></div><div>${esc(h.originKind)} · ${esc(h.state)}</div><div class="when">${esc(h.candidateKey)}</div></div></div>`;
    })
    .join("");
}

function renderFindings(): void {
  const findings = view?.reflection?.findings ?? [];
  must("#cntFind").textContent = String(findings.length);
  must("#findingList").innerHTML = findings
    .map((f, i) => {
      const sev = f.severity === "warning" || f.severity === "major" ? "warning" : f.severity === "pass" || f.severity === "ok" ? "pass" : "info";
      const last = f.sourceAnchorIds[f.sourceAnchorIds.length - 1];
      const keys =
        f.sourceAnchorIds.length > 3
          ? `<span class="akey">${esc(f.sourceAnchorIds[0] ?? "")}–${esc(last ?? "")}</span>`
          : f.sourceAnchorIds.map((k) => `<span class="akey">${esc(k)}</span>`).join("");
      return `<button class="finding${activeFinding === i ? " is-active" : ""}" data-f="${i}" type="button">
        <div class="fhead"><i class="sev sev-${sev}"></i><span class="mono">${esc(f.findingKind)}</span><span>· ${esc(f.severity)}</span><span style="margin-left:auto">${f.candidateKey ? esc(f.candidateKey) : "전역"}</span></div>
        <div>${esc(f.message)}</div>
        <div class="row" style="gap:4px;flex-wrap:wrap">${keys}</div>
      </button>`;
    })
    .join("");
}

function renderChat(): void {
  const list = must("#chatList");
  const msgs = view?.chat ?? [];
  if (!msgs.length) {
    list.innerHTML = '<p class="muted" style="font-size:12px;padding:8px">채팅 기록이 없습니다. 보내기는 M3에서 로컬 CLI 호출이 연결됩니다.</p>';
    return;
  }
  list.innerHTML = msgs
    .map((m) => {
      const when = m.createdAt.length >= 16 ? m.createdAt.slice(11, 16) : m.createdAt;
      if (m.role === "user") {
        return `<div class="msg msg-user"><div class="msg-head"><span>나</span><span>${esc(when)}</span></div><div class="msg-body">${esc(m.text)}</div></div>`;
      }
      return `<div class="msg msg-ai"><div class="msg-head"><span class="tag tag-line">assistant</span><span>${esc(when)}</span></div><div class="msg-body"><p>${esc(m.text)}</p>${m.meta ? `<dl class="run-card"><dt>meta</dt><dd>${esc(m.meta)}</dd></dl>` : ""}</div></div>`;
    })
    .join("");
}

function renderTerms(): void {
  const entries = Object.entries(terms);
  must("#ctxTerms").innerHTML = entries.length
    ? entries
        .map(([k, t]) => {
          const a = view?.anchors.find((x) => (x.punctuatedQuote || "").includes(k));
          const cls = t.status === "preferred" ? "tag-ok" : "tag-plain";
          return `<div class="li"><span><b class="hanmun">${esc(k)}</b> → ${esc(t.target)}</span><span class="row" style="gap:6px"><span class="tag ${cls}">${esc(t.status)}</span><span class="mono muted">${a ? esc(a.anchorKey) : "—"}</span></span></div>`;
        })
        .join("")
    : '<p class="muted" style="font-size:12px">일치한 용어가 없습니다.</p>';
  const people = knowledge?.persons ?? [];
  const places = knowledge?.places ?? [];
  must("#ctxPeople").innerHTML =
    [...people.map((p) => `<div class="li"><span><b class="hanmun">${esc(p.hanjaName || p.preferredName)}</b> ${esc(p.reading ?? p.preferredName)} <span class="muted">· 인물</span></span><span class="muted">${esc(p.dateText ?? "")}</span></div>`),
      ...places.map((p) => `<div class="li"><span><b class="hanmun">${esc(p.hanjaName || p.preferredName)}</b> ${esc(p.reading ?? "")} <span class="muted">· 지명</span></span></div>`)].join("") ||
    '<p class="muted" style="font-size:12px">인물·지명이 없습니다.</p>';
  const unc = knowledge?.uncertainties.filter((u) => u.state === "open") ?? [];
  must("#ctxUnc").innerHTML = unc.length
    ? unc
        .map(
          (u) =>
            `<div class="li"><span><b>${esc(u.id.slice(0, 8))}</b> ${esc(u.statementMd)}</span><span class="tag tag-warn">${esc(u.category)}</span></div>`,
        )
        .join("")
    : '<p class="muted" style="font-size:12px">열린 불확실성이 없습니다.</p>';
}

function renderDocMeta(): void {
  if (!view) return;
  const d = view.document;
  must("#docMeta").innerHTML = `<dt>구조</dt><dd>${esc(d.structuralKind)}${d.genre ? ` · ${esc(d.genre)}` : ""}</dd>
    <dt>저자</dt><dd>${esc(d.authorName ?? "—")}</dd>
    <dt>시기</dt><dd>${esc(d.periodText ?? "—")}</dd>
    <dt>언어</dt><dd>${esc(d.language ?? "—")}</dd>
    <dt>서지</dt><dd>${esc(d.sourceReference ?? "—")}</dd>`;
  must("#refLink").textContent = d.originalTitle || d.title;
  must("#anchorCount").textContent = String(view.anchors.length);
  must("#sbPath").textContent = `${shortPath(view.project.packagePath)} › ${d.originalTitle || d.title}`;
  must("#sbVersions").textContent = `원문 V${view.source.versionNo} · 표점 P${view.punctuation.versionNo} · 앵커 ${view.anchors.length}`;
}

function renderAll(): void {
  renderSource();
  renderRows();
  renderFull();
  renderStrip();
  renderHistory();
  renderFindings();
  renderChat();
  renderTerms();
  renderDocMeta();
}

function setHot(keys: string[]): void {
  hot = keys;
  const bs = shownBlocks();
  const has = (b: Block | undefined): boolean => !!b && b.anchors.some((k) => keys.includes(k));
  $$("#sourceText .anchor").forEach((a) => a.classList.toggle("is-hot", keys.includes(a.dataset.key ?? "")));
  $$("#rows .akey").forEach((k) => k.classList.toggle("is-hot", keys.includes(k.dataset.akey ?? "")));
  $$("#rows .brow").forEach((r) => r.classList.toggle("is-hot", has(bs.find((x) => x.key === r.dataset.key))));
  $$("#fullText .blk").forEach((s) => s.classList.toggle("is-hot", has(bs.find((x) => x.key === s.dataset.key))));
}

function setView(v: Layout): void {
  layout = v;
  $$("#viewSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  $$(".view").forEach((el) => el.classList.toggle("is-open", el.id === `view${v[0]?.toUpperCase()}${v.slice(1)}`));
}

function setTab(t: string): void {
  $$("#rtabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $$(".rpanel").forEach((p) => p.classList.toggle("is-open", p.id === `rp-${t}`));
  if ($("#ws")?.classList.contains("no-ctx")) togglePane("ctx", false);
}

function selectRow(key: string): void {
  active = key;
  $$("#rows .brow").forEach((x) => x.classList.toggle("is-active", x.dataset.key === key));
}

function togglePane(which: "ref" | "ctx", force?: boolean): void {
  const ws = must("#ws");
  const cls = which === "ref" ? "no-ref" : "no-ctx";
  const hide = force !== undefined ? force : !ws.classList.contains(cls);
  ws.classList.toggle(cls, hide);
  store.set(`munhae.${which}`, hide ? "0" : "1");
  $(which === "ref" ? "#tbRef" : "#tbCtx")?.classList.toggle("is-on", !hide);
}

function applyView(v: EditorView, keepStage?: string): void {
  if (view?.document.id !== v.document.id) {
    prepPreview = null;
    prepDocId = null;
    prepAuxMode.clear();
  }
  view = v;
  const current = cand(v);
  stage = keepStage ?? v.activeStage ?? current?.stage ?? "";
  const currentOfStage =
    v.candidates.find((c) => c.stage === stage && c.isCurrent) ??
    v.candidates.find((c) => c.stage === stage) ??
    current;
  editingKey = currentOfStage?.candidateKey ?? current?.candidateKey ?? "";
  viewingKey = editingKey;
  blocks = currentOfStage ? blocksFrom(currentOfStage) : [];
  dirty = false;
  active = null;
  renderAll();
  setSelfTitle(`${v.document.originalTitle || v.document.title} — ${v.project.title}`);
}

function payloadBlocks(): SaveBlocks {
  return blocks.map((b) => ({
    blockKey: b.key,
    blockKind: b.kind || "paragraph",
    translation: b.text,
    sourceAnchorIds: b.anchors,
  }));
}

type SaveBlocks = Array<{
  blockKey: string;
  blockKind: string;
  translation: string;
  sourceAnchorIds: string[];
}>;

async function saveDraft(): Promise<EditorView | null> {
  if (!view || !editing()) return view;
  const result = await api.editor.saveDraft({
    documentNodeId: view.document.id,
    stage,
    textContent: joinBlocks(blocks),
    blocks: payloadBlocks(),
    expectedLockVersion: view.lockVersion,
  });
  const data = unwrap(result, "저장");
  if (data) {
    dirty = false;
    must("#sbSaved").textContent = nowHM();
    applyView(data, stage);
    return data;
  }
  return null;
}

async function saveIfDirty(): Promise<void> {
  if (dirty) await saveDraft();
}

function collectEdits(): void {
  if (!editing()) return;
  $$("#rows .tgt-edit").forEach((el) => {
    const key = el.dataset.edit;
    const b = blocks.find((x) => x.key === key);
    if (b) {
      const t = el.textContent?.trim() ?? "";
      if (t !== b.text) {
        b.text = t;
        dirty = true;
      }
    }
  });
}

function openCtx(i: number, x: number, y: number): void {
  cmIdx = i;
  const can = editing();
  const bs = shownBlocks();
  const cm = must("#ctxmenu");
  cm.innerHTML = `<button data-cm="merge" type="button"${!can || i === bs.length - 1 ? " disabled" : ""}>다음 블록과 합치기<kbd>⌥⌘M</kbd></button><button data-cm="split" type="button"${can ? "" : " disabled"}>나누기…<kbd>⌥⌘S</kbd></button><button data-cm="link" type="button"${can ? "" : " disabled"}>앵커 연결…<kbd>⌥⌘L</kbd></button><hr><button data-cm="source" type="button">표점 전문에서 보기</button><button data-cm="diff" type="button">변경 비교<kbd>⌘D</kbd></button>${can ? "" : "<hr><button type='button' disabled>AI 제안은 채택한 뒤 편집할 수 있습니다</button>"}`;
  cm.classList.add("show");
  const w = cm.offsetWidth;
  const h = cm.offsetHeight;
  cm.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  cm.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
}

async function mergeAt(i: number): Promise<void> {
  if (!view) return;
  collectEdits();
  await saveIfDirty();
  const bs = blocks;
  const left = bs[i];
  const right = bs[i + 1];
  if (!left || !right) return;
  const result = await api.editor.mergeBlocks({
    documentNodeId: view.document.id,
    stage,
    leftBlockKey: left.key,
    rightBlockKey: right.key,
    expectedLockVersion: view.lockVersion,
  });
  const data = unwrap(result, "합치기");
  if (data) {
    applyView(data, stage);
    notify("블록을 합쳤습니다", "블록");
  }
}

function openSplit(i: number): void {
  splitIdx = i;
  const b = blocks[i];
  if (!b) return;
  must<HTMLTextAreaElement>("#splitText").value = b.text;
  must("#splitAnchors").innerHTML =
    b.anchors.length > 1
      ? b.anchors
          .slice(0, -1)
          .map(
            (k, j) =>
              `<label><input type="radio" name="sa" value="${j + 1}" ${j === 0 ? "checked" : ""}> 앞 블록: ${esc(b.anchors.slice(0, j + 1).join(", "))} <span class="muted">/ 뒤 블록: ${esc(b.anchors.slice(j + 1).join(", "))}</span></label>`,
          )
          .join("")
      : `<label><input type="radio" name="sa" value="end" checked> 번역문 커서 위치에서 나눕니다</label>`;
  (must("#dlgSplit") as HTMLDialogElement).showModal();
}

function openLink(i: number): void {
  linkIdx = i;
  const b = blocks[i];
  if (!b || !view) return;
  must("#linkAnchors").innerHTML = view.anchors
    .map(
      (a) =>
        `<label><input type="checkbox" name="la" value="${esc(a.anchorKey)}" ${b.anchors.includes(a.anchorKey) ? "checked" : ""}> <span class="mono">${esc(a.anchorKey)}</span> <span class="hanmun" style="font-size:14px">${esc(quoteFor(a.anchorKey))}</span></label>`,
    )
    .join("");
  (must("#dlgLink") as HTMLDialogElement).showModal();
}

function openDiff(): void {
  if (!view) return;
  const sorted = [...view.candidates].sort((a, b) => a.versionNo - b.versionNo);
  const cur = cand(view, viewingKey) ?? sorted[sorted.length - 1];
  const prev = sorted.filter((c) => c.candidateKey !== cur?.candidateKey).at(-1) ?? sorted[0];
  if (!cur || !prev) {
    notify("비교할 번역안이 없습니다", "변경 비교");
    return;
  }
  const sp = (s: string): string[] => s.split(/(?<=[.。])\s*/).filter(Boolean);
  const A = sp(prev.textContent);
  const B = sp(cur.textContent);
  const col = (title: string, xs: string[], other: string[]): string =>
    `<div><div class="muted" style="font-size:11.5px;margin-bottom:6px">${title}</div>${xs.map((s) => `<span class="${other.includes(s) ? "" : "chg"}">${esc(s)}</span> `).join("")}</div>`;
  must("#diffCols").innerHTML =
    col(`v${prev.versionNo} · ${esc(stageLabel(prev.stage))}`, A, B) +
    col(`v${cur.versionNo} · ${esc(stageLabel(cur.stage))}`, B, A);
  (must("#dlgDiff") as HTMLDialogElement).showModal();
}

function openConfirm(): void {
  if (!view) return;
  const c = cand(view, editingKey);
  must("#confirmText").textContent = `번역안 v${c?.versionNo ?? ""} (${stageLabel(stage)})을 확정합니다. 확정은 내용 승인이며 공유와는 별개입니다.`;
  must("#confirmKv").innerHTML = `<dt>참조</dt><dd class="mono">원문 V${view.source.versionNo} · 표점 P${view.punctuation.versionNo}</dd><dt>검증</dt><dd>${validate(blocks).length ? "needs_review" : "valid"}</dd><dt>공유</dt><dd class="muted">확정과 별개 — 이 로컬 프로젝트는 공유하지 않습니다</dd>`;
  (must("#dlgConfirm") as HTMLDialogElement).showModal();
}

function showNoSource(msg: string): void {
  must("#noSource").hidden = false;
  must("#ws").hidden = true;
  const p = $("#noSource p");
  if (p) p.textContent = msg;
}

async function loadEditor(id: string): Promise<void> {
  persistDoc(id);
  const result = await api.editor.get(id);
  if (!result.ok) {
    showNoSource(result.error.message || "원문이 없습니다.");
    return;
  }
  const v = result.data;
  if (!v.source.contentText && !v.punctuation.punctuatedText) {
    showNoSource("이 문서에는 아직 원문안이 없습니다. 프로젝트 홈에서 원문을 붙여넣으세요.");
    applyView(v);
    return;
  }
  must("#noSource").hidden = true;
  must("#ws").hidden = false;
  applyView(v);
  renderSidebar(tree(), { currentDocId: id });
}

function pageCmd(id: string): boolean {
  const i = editing() ? blocks.findIndex((b) => b.key === active) : -1;
  switch (id) {
    case "refpane":
      togglePane("ref");
      return true;
    case "ctxpane":
      togglePane("ctx");
      return true;
    case "v-source":
      setView("source");
      return true;
    case "v-parallel":
      setView("parallel");
      return true;
    case "v-full":
      setView("full");
      return true;
    case "struct":
      must<HTMLInputElement>("#chkStruct").click();
      return true;
    case "keys":
      must<HTMLInputElement>("#chkKeys").click();
      return true;
    case "prepare":
    case "run":
    case "reflect":
      openPreparation();
      return true;
    case "diff":
      openDiff();
      return true;
    case "confirm": {
      const b = must<HTMLButtonElement>("#btnConfirm");
      if (b.hidden) notify("이미 확정된 번역안입니다. 수정하려면 새 번역안을 만드세요", "확정");
      else if (b.disabled) notify(b.title, "확정");
      else openConfirm();
      return true;
    }
    case "merge":
    case "split":
    case "link":
      if (!editing()) {
        notify("AI 제안은 읽기 전용입니다. 채택한 뒤 편집하세요", "블록");
        return true;
      }
      if (i < 0) {
        notify("대조 보기에서 블록을 먼저 선택하세요", "블록");
        return true;
      }
      if (id === "merge") {
        if (i === blocks.length - 1) notify("마지막 블록은 다음 블록과 합칠 수 없습니다", "블록");
        else void mergeAt(i);
      } else if (id === "split") openSplit(i);
      else openLink(i);
      return true;
    case "find":
      notify("찾기는 아직 연결되어 있지 않습니다", "편집");
      return true;
  }
  return false;
}

function pageKeys(e: KeyboardEvent, m: boolean): void {
  const typing = (e.target as HTMLElement).matches("textarea,input,[contenteditable=true]");
  if (m && !e.shiftKey && !e.altKey && /^Digit[1-3]$/.test(e.code)) {
    e.preventDefault();
    const views: Layout[] = ["source", "parallel", "full"];
    const v = views[Number(e.code.slice(5)) - 1];
    if (v) setView(v);
    return;
  }
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyD") {
    e.preventDefault();
    openDiff();
    return;
  }
  if (m && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    void pageCmd("confirm");
    return;
  }
  if (m && e.altKey) {
    const map: Record<string, string> = { KeyR: "refpane", KeyM: "merge", KeyS: "split", KeyL: "link", KeyK: "prepare" };
    const cmdId = map[e.code];
    if (cmdId) {
      e.preventDefault();
      void pageCmd(cmdId);
    }
  }
  if (!typing && e.key === "Escape") {
    active = null;
    renderRows();
  }
}

must("#tbRef").innerHTML = ic("image");
must("#tbCtx").innerHTML = ic("panel");
must("#tbRef").addEventListener("click", () => togglePane("ref"));
must("#tbCtx").addEventListener("click", () => togglePane("ctx"));
must("#btnPrepare").addEventListener("click", openPreparation);
const refPref = store.get("munhae.ref");
togglePane("ref", refPref ? refPref === "0" : innerWidth < 1500);
togglePane("ctx", store.get("munhae.ctx") === "0");

$$(".gutter").forEach((g) =>
  g.addEventListener("pointerdown", (e) => {
    const ws = must("#ws");
    const side = g.dataset.side;
    const v = side === "l" ? "--lw" : "--rw";
    const start = e.clientX;
    const startW = parseFloat(getComputedStyle(ws).getPropertyValue(v)) || (side === "l" ? 260 : 340);
    g.classList.add("is-drag");
    g.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    const mv = (ev: PointerEvent): void => {
      const d = ev.clientX - start;
      const w = side === "l" ? Math.min(460, Math.max(200, startW + d)) : Math.min(560, Math.max(280, startW - d));
      ws.style.setProperty(v, `${w}px`);
    };
    const up = (): void => {
      g.classList.remove("is-drag");
      document.body.style.cursor = "";
      g.removeEventListener("pointermove", mv);
      g.removeEventListener("pointerup", up);
    };
    g.addEventListener("pointermove", mv);
    g.addEventListener("pointerup", up);
  }),
);

must("#viewSeg").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b instanceof HTMLElement && b.dataset.view) setView(b.dataset.view as Layout);
});
must<HTMLInputElement>("#chkStruct").addEventListener("change", (e) =>
  document.body.classList.toggle("show-struct", (e.target as HTMLInputElement).checked),
);
must<HTMLInputElement>("#chkKeys").addEventListener("change", (e) =>
  document.body.classList.toggle("show-keys", (e.target as HTMLInputElement).checked),
);
must("#rtabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b instanceof HTMLElement && b.dataset.tab) setTab(b.dataset.tab);
});
document.addEventListener("click", (e) => {
  const g = (e.target as HTMLElement).closest("[data-goto]");
  if (g instanceof HTMLElement && g.dataset.goto) setTab(g.dataset.goto);
});
must("#candSeg").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!(b instanceof HTMLElement)) return;
  viewingKey = b.dataset.cand ?? viewingKey;
  stage = b.dataset.stage ?? stage;
  active = null;
  activeFinding = null;
  renderAll();
});
must("#btnAdopt").addEventListener("click", () => {
  void (async () => {
    const c = viewing();
    if (!c || !view) return;
    stage = c.stage;
    viewingKey = c.candidateKey;
    editingKey = c.candidateKey;
    blocks = blocksFrom(c);
    dirty = true;
    const saved = await saveDraft();
    if (saved) notify(`${stageLabel(c.stage)}을 채택했습니다`, "번역안");
  })();
});

const src = must("#sourceText");
src.addEventListener("mouseover", (e) => {
  const a = (e.target as HTMLElement).closest(".anchor");
  if (a instanceof HTMLElement && a.dataset.key) setHot([a.dataset.key]);
});
src.addEventListener("mouseout", (e) => {
  const t = e.target as HTMLElement;
  const rel = e.relatedTarget as HTMLElement | null;
  if (t.closest(".anchor") && !rel?.closest(".anchor")) setHot([]);
});
src.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest(".anchor");
  if (!(a instanceof HTMLElement) || !a.dataset.key) return;
  const b = shownBlocks().find((x) => x.anchors.includes(a.dataset.key ?? ""));
  if (b) {
    active = b.key;
    setHot(b.anchors);
    setView("parallel");
    renderRows();
  }
});

const rows = must("#rows");
rows.addEventListener("mouseover", (e) => {
  const k = (e.target as HTMLElement).closest(".akey");
  if (k instanceof HTMLElement && k.dataset.akey) {
    setHot([k.dataset.akey]);
    return;
  }
  const r = (e.target as HTMLElement).closest(".brow");
  if (r instanceof HTMLElement) {
    const b = shownBlocks().find((x) => x.key === r.dataset.key);
    if (b && hot.join() !== b.anchors.join()) setHot(b.anchors);
  }
});
rows.addEventListener("mouseleave", () => setHot([]));
rows.addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).closest(".brow");
  if (!(r instanceof HTMLElement) || !r.dataset.key) return;
  selectRow(r.dataset.key);
  const more = (e.target as HTMLElement).closest(".more");
  if (more instanceof HTMLElement) {
    e.stopPropagation();
    const rc = more.getBoundingClientRect();
    openCtx(Number(more.dataset.more), rc.right - 212, rc.bottom + 4);
  }
});
rows.addEventListener("contextmenu", (e) => {
  const r = (e.target as HTMLElement).closest(".brow");
  if (!(r instanceof HTMLElement) || !r.dataset.key) return;
  e.preventDefault();
  selectRow(r.dataset.key);
  openCtx(Number(r.dataset.i), e.clientX, e.clientY);
});
rows.addEventListener("focusout", (e) => {
  const ed = (e.target as HTMLElement).closest(".tgt-edit");
  if (!(ed instanceof HTMLElement) || !editing()) return;
  const b = blocks.find((x) => x.key === ed.dataset.edit);
  const t = ed.textContent?.trim() ?? "";
  if (b && t !== b.text) {
    b.text = t;
    dirty = true;
    void saveDraft().then(() => notify("번역안을 저장했습니다", "자동 저장"));
  }
});
must("#fullText").addEventListener("click", (e) => {
  const s = (e.target as HTMLElement).closest(".blk");
  if (s instanceof HTMLElement && s.dataset.key) {
    active = s.dataset.key;
    setView("parallel");
    renderRows();
  }
});
must("#fullText").addEventListener("mouseover", (e) => {
  const s = (e.target as HTMLElement).closest(".blk");
  if (s instanceof HTMLElement) {
    const b = shownBlocks().find((x) => x.key === s.dataset.key);
    if (b) setHot(b.anchors);
  }
});
must("#fullText").addEventListener("mouseleave", () => setHot([]));

const cm = must("#ctxmenu");
cm.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-cm]");
  if (!(b instanceof HTMLButtonElement) || b.disabled) return;
  cm.classList.remove("show");
  const i = cmIdx ?? -1;
  const act = b.dataset.cm;
  if (act === "merge") void mergeAt(i);
  else if (act === "split") openSplit(i);
  else if (act === "link") openLink(i);
  else if (act === "source") {
    const blk = shownBlocks()[i];
    if (blk) {
      setHot(blk.anchors);
      setView("source");
    }
  } else if (act === "diff") openDiff();
});

must("#splitCancel").addEventListener("click", () => (must("#dlgSplit") as HTMLDialogElement).close());
must("#splitOk").addEventListener("click", () => {
  void (async () => {
    if (splitIdx === null || !view) return;
    const ta = must<HTMLTextAreaElement>("#splitText");
    const pos = ta.selectionStart;
    if (pos <= 0 || pos >= ta.value.length) {
      notify("나눌 위치에 커서를 두세요", "블록 나누기");
      ta.focus();
      return;
    }
    const b = blocks[splitIdx];
    if (!b) return;
    collectEdits();
    await saveIfDirty();
    const result = await api.editor.splitBlock({
      documentNodeId: view.document.id,
      stage,
      blockKey: b.key,
      splitAt: pos,
      expectedLockVersion: view.lockVersion,
    });
    const data = unwrap(result, "나누기");
    if (data) {
      (must("#dlgSplit") as HTMLDialogElement).close();
      applyView(data, stage);
      notify("블록을 나눴습니다", "블록");
    }
  })();
});
must("#linkCancel").addEventListener("click", () => (must("#dlgLink") as HTMLDialogElement).close());
must("#linkOk").addEventListener("click", () => {
  void (async () => {
    if (linkIdx === null) return;
    const sel = $$<HTMLInputElement>('input[name="la"]:checked').map((x) => x.value);
    const b = blocks[linkIdx];
    if (!b) return;
    b.anchors = sel;
    dirty = true;
    (must("#dlgLink") as HTMLDialogElement).close();
    const saved = await saveDraft();
    if (saved) notify("앵커 연결을 저장했습니다", "앵커 연결");
  })();
});
must("#btnConfirm").addEventListener("click", openConfirm);
must("#confirmCancel").addEventListener("click", () => (must("#dlgConfirm") as HTMLDialogElement).close());
must("#confirmOk").addEventListener("click", () => {
  void (async () => {
    if (!view) return;
    collectEdits();
    await saveIfDirty();
    const c = cand(view, editingKey);
    const result = await api.editor.confirm({
      documentNodeId: view.document.id,
      stage,
      expectedLockVersion: view.lockVersion,
    });
    const data = unwrap(result, "확정");
    if (data) {
      (must("#dlgConfirm") as HTMLDialogElement).close();
      applyView(data, stage);
      notify("번역안을 확정했습니다", "확정");
    }
  })();
});
must("#btnRevise").addEventListener("click", () => {
  void (async () => {
    if (!view) return;
    const result = await api.editor.revise(view.document.id, stage);
    const data = unwrap(result, "새 번역안");
    if (data) {
      applyView(data, stage);
      notify("새 번역안이 열렸습니다. 확정본은 유지됩니다", "새 번역안");
    }
  })();
});
must("#btnDiff").addEventListener("click", openDiff);
must("#diffClose").addEventListener("click", () => (must("#dlgDiff") as HTMLDialogElement).close());
must("#findingList").addEventListener("click", (e) => {
  const f = (e.target as HTMLElement).closest(".finding");
  if (!(f instanceof HTMLElement)) return;
  const i = Number(f.dataset.f);
  activeFinding = i;
  const fd = view?.reflection?.findings[i];
  if (!fd) return;
  if (fd.candidateKey && view) {
    const c = view.candidates.find((x) => x.candidateKey === fd.candidateKey);
    if (c) {
      viewingKey = c.candidateKey;
      stage = c.stage;
    }
  }
  setView("parallel");
  hot = fd.sourceAnchorIds;
  renderAll();
});
must("#btnReflect").addEventListener("click", openPreparation);
must("#btnCtxAll").addEventListener("click", openPreparation);
must("#prepClose").addEventListener("click", () => (must("#dlgPrepare") as HTMLDialogElement).close());
must("#prepCloseTop").addEventListener("click", () => (must("#dlgPrepare") as HTMLDialogElement).close());
must("#prepRecipe").addEventListener("change", () => void loadPreparation(true));
must("#prepAgent").addEventListener("change", () => {
  if (prepPreview) renderPreparation();
});
must("#prepAux").addEventListener("click", (e) => {
  const button = (e.target as HTMLElement).closest("button[data-prep-mode]");
  if (!(button instanceof HTMLElement)) return;
  const id = button.closest("[data-prep-id]")?.getAttribute("data-prep-id");
  const mode = button.dataset.prepMode as "auto" | "pin" | "exclude" | undefined;
  if (!id || !mode) return;
  prepAuxMode.set(id, mode);
  void loadPreparation(true);
});
must("#prepRun").addEventListener("click", () => {
  notify("로컬 CLI 실행은 아직 연결되지 않았습니다", "AI 번역");
});
must<HTMLFormElement>("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = must<HTMLTextAreaElement>("#chatInput").value.trim();
  if (!v) return;
  notify("M3에서 로컬 CLI 호출이 연결됩니다", "채팅");
});
must("#chatInput").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    notify("M3에서 로컬 CLI 호출이 연결됩니다", "채팅");
  }
});
function renderPage(): void {
  must("#pgLabel").textContent = `${page} / ${PAGES}`;
  must("#pageFile").textContent = `assets/derivatives/page-000${page}`;
  (must("#pgPrev") as HTMLButtonElement).disabled = page === 1;
  (must("#pgNext") as HTMLButtonElement).disabled = page === PAGES;
}
must("#pgPrev").addEventListener("click", () => {
  page = Math.max(1, page - 1);
  renderPage();
});
must("#pgNext").addEventListener("click", () => {
  page = Math.min(PAGES, page + 1);
  renderPage();
});

const tc = must("#termCard");
document.addEventListener("mouseover", (e) => {
  const t = (e.target as HTMLElement).closest(".term");
  if (!(t instanceof HTMLElement)) {
    if (!(e.target as HTMLElement).closest(".term-card")) tc.classList.remove("show");
    return;
  }
  const d = terms[t.dataset.term ?? ""];
  if (!d) return;
  tc.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:5px"><b class="hanmun" style="font-size:15px">${esc(t.dataset.term ?? "")}</b><span class="tag ${d.status === "preferred" ? "tag-ok" : "tag-plain"}">${esc(d.status)}</span></div><div><b>${esc(d.target)}</b> <span class="muted">· ${esc(d.kind)}</span></div><p class="muted" style="margin-top:5px">${esc(d.note)}</p>`;
  const r = t.getBoundingClientRect();
  const x = Math.min(r.left, innerWidth - 296);
  const y = r.bottom + 8 > innerHeight - 160 ? r.top - 160 : r.bottom + 8;
  tc.style.left = `${x}px`;
  tc.style.top = `${y}px`;
  tc.classList.add("show");
});

must("#btnHome").addEventListener("click", () => go("home"));
must("#btnSaveSource").addEventListener("click", () => {
  notify("원문 저장 IPC가 없습니다. 프로젝트 홈에서 문서를 만들 때 원문을 붙여넣으세요", "원문");
  go("home");
});

bindSidebar(
  (id) => {
    const document = docs.find((item) => item.id === id);
    if (document?.nodeRole === "container") {
      notify(`${document.originalTitle || document.title}: 원문·표점안이 없는 목차 폴더입니다`, "목차 폴더");
      return;
    }
    void loadEditor(id);
  },
  undefined,
  tree,
);

async function boot(): Promise<void> {
  const home = await api.home.get();
  if (home.ok) {
    docs = home.data.documents;
    setSelfTitle(`편집 — ${home.data.project.title}`);
  }
  let id = readPersistedDoc();
  if (!id) id = findDefaultDoc(docs);
  renderSidebar(tree(), { currentDocId: id });
  renderPage();
  try {
    const kn = await api.knowledge.get();
    if (kn.ok) {
      knowledge = kn.data;
      const map: Record<string, TermInfo> = {};
      for (const g of kn.data.glossary) {
        const prev = map[g.sourceTerm];
        if (!prev || g.usageStatus === "preferred") {
          map[g.sourceTerm] = {
            target: g.targetTerm,
            kind: g.termKind,
            status: g.usageStatus,
            note: g.noteMd ?? "",
          };
        }
      }
      terms = map;
    }
  } catch {
    /* optional */
  }
  if (!id) {
    showNoSource("열 문서가 없습니다. 프로젝트 홈에서 문서를 선택하세요.");
    return;
  }
  await loadEditor(id);
  if (store.get("munhae.prepare") === "1") {
    store.set("munhae.prepare", "0");
    openPreparation();
  }
}

void boot();
