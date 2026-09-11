import type {
  DocumentHistoryView,
  MunhaeApi,
  VersionDiffView,
  VersionHistoryEntry,
  VersionHistoryKind,
} from "../../shared/munhae-api";

type HistoryUiDeps = {
  api: MunhaeApi;
  escape(value: unknown): string;
  notify(message: string, title?: string): void;
};

let deps: HistoryUiDeps | null = null;
let history: DocumentHistoryView | null = null;
let loadingDocumentId: string | null = null;
let requestNo = 0;
let selectedKind: VersionHistoryKind = "translation";
let selectedStage = "translation";

function must<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

function kindLabel(kind: VersionHistoryKind): string {
  return kind === "source" ? "원문" : kind === "punctuation" ? "표점 원문" : "번역";
}

function stateLabel(entry: VersionHistoryEntry): string {
  if (entry.isConfirmed) return "확정본";
  if (entry.isCurrent) return "현재 버전";
  if (entry.state === "superseded") return "변경 이력";
  if (entry.state === "rejected") return "제외됨";
  return "작업안";
}

function when(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function validationLabel(value: VersionHistoryEntry["validationState"]): string {
  return value === "valid" ? "형식 검사 통과" : value === "needs_review" ? "형식 확인 필요" : "";
}

function metadataRows(entry: VersionHistoryEntry): string {
  if (!deps) return "";
  const rows: Array<[string, string | null]> = [
    ["버전 식별자", entry.versionId],
    ["이전 버전 식별자", entry.parentVersionId],
    ["내용 해시", entry.contentHash],
    ["작성자", entry.createdBy],
    ["생성 시각", entry.createdAt],
    ["생성 방식", entry.originKind],
  ];
  if (entry.changeSummary) rows.push(["변경 요약", entry.changeSummary]);
  if (entry.validationState) rows.push(["형식 검사", validationLabel(entry.validationState)]);
  if (entry.sourceTextVersionId) rows.push(["원문 버전", `${entry.sourceTextVersionId} · ${entry.sourceTextHash ?? "해시 없음"}`]);
  if (entry.punctuationVersionId) rows.push(["표점 버전", `${entry.punctuationVersionId} · ${entry.punctuationHash ?? "해시 없음"}`]);
  if (entry.anchorSetId) rows.push(["원문 연결 집합", `${entry.anchorSetId} · ${entry.anchorSetHash ?? "해시 없음"}`]);
  if (entry.translationPolicyVersionId) rows.push(["번역 원칙", `${entry.translationPolicyVersionId} · ${entry.translationPolicyHash ?? "해시 없음"}`]);
  if (entry.kind === "punctuation") rows.push(["구조 범위", `${entry.structureSpanCount}개`]);
  return rows.map(([key, value]) => `<dt>${deps!.escape(key)}</dt><dd class="mono" style="overflow-wrap:anywhere">${deps!.escape(value ?? "—")}</dd>`).join("");
}

function blocksHtml(entry: VersionHistoryEntry): string {
  if (!deps || !entry.blocks.length) return "";
  return `<details><summary>번역 블록 ${entry.blocks.length}개 · 앵커 연결</summary><div class="list" style="margin-top:8px">${entry.blocks.map((block) => `
    <div class="li" style="display:grid;gap:4px">
      <span class="row" style="gap:5px"><b class="mono">${deps!.escape(block.blockKey)}</b><span class="tag tag-plain">${deps!.escape(block.blockKind)}</span><span class="sp"></span><span class="mono muted">${deps!.escape(block.targetHash.slice(0, 12))}</span></span>
      <span>${deps!.escape(block.translation)}</span>
      <span class="mono muted" style="font-size:10.5px">${deps!.escape(block.anchors.map((anchor) => `${anchor.anchorKey}:${anchor.relationKind}`).join(" · ") || "앵커 없음")}</span>
    </div>`).join("")}</div></details>`;
}

function currentEntries(): VersionHistoryEntry[] {
  if (!history) return [];
  return history.entries.filter((entry) => entry.kind === selectedKind && (selectedKind !== "translation" || entry.stage === selectedStage));
}

function render(): void {
  const root = document.querySelector("#histList");
  if (!root || !deps) return;
  if (loadingDocumentId && (!history || history.documentNodeId !== loadingDocumentId)) {
    root.innerHTML = '<p class="muted" style="font-size:12px">저장된 이력을 불러오는 중입니다…</p>';
    return;
  }
  if (!history) {
    root.innerHTML = '<p class="muted" style="font-size:12px">이력을 불러오지 못했습니다.</p>';
    return;
  }
  const stages = [...new Set(history.entries.filter((entry) => entry.kind === "translation" && entry.stage).map((entry) => entry.stage!))];
  if (selectedKind === "translation" && !stages.includes(selectedStage)) {
    selectedStage = stages.includes("translation")
      ? "translation"
      : history.entries.find((entry) => entry.kind === "translation" && entry.isCurrent)?.stage ?? stages[0] ?? "translation";
  }
  const entries = currentEntries().sort((left, right) => right.versionNo - left.versionNo || right.createdAt.localeCompare(left.createdAt));
  root.innerHTML = `
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:9px">
      <select class="select" data-history-kind aria-label="이력 종류">
        ${(["source", "punctuation", "translation"] as const).map((kind) => `<option value="${kind}"${kind === selectedKind ? " selected" : ""}>${kindLabel(kind)}</option>`).join("")}
      </select>
      <button class="btn btn-sm" type="button" data-history-compare${entries.length < 2 ? " disabled" : ""}>이전 내용과 비교…</button>
    </div>
    <p class="muted" style="font-size:11.5px;margin-bottom:8px">저장할 때마다 남긴 내용을 확인하고, 두 버전의 변경 부분을 비교하세요.</p>
    ${entries.length ? entries.map((entry) => {
      const tagClass = entry.isConfirmed ? "tag-ok" : entry.validationState === "needs_review" ? "tag-warn" : entry.isCurrent ? "tag-draft" : "tag-plain";
      return `<details class="hist-item" data-history-version="${deps!.escape(entry.versionId)}">
        <summary style="display:grid;grid-template-columns:36px 1fr;gap:7px;cursor:pointer;list-style:none">
          <span class="v">v${entry.versionNo}</span>
          <span><span class="row" style="gap:5px;flex-wrap:wrap"><span class="tag ${tagClass}">${stateLabel(entry)}</span></span><span class="when">${deps!.escape(when(entry.createdAt))} · ${deps!.escape(entry.createdBy)}</span>${entry.changeSummary ? `<span style="display:block;font-size:12px;margin-top:4px">${deps!.escape(entry.changeSummary)}</span>` : ""}</span>
        </summary>
        <div style="grid-column:1/-1;padding:8px 0 2px;display:grid;gap:8px">
          <pre class="source-reference" aria-label="이 버전의 전체 내용" style="margin:0;max-height:300px;overflow:auto;white-space:pre-wrap">${deps!.escape(entry.contentText)}</pre>
          <details><summary>원문·생성 기록 자세히</summary><dl class="kv" style="margin-top:8px">${metadataRows(entry)}</dl>${blocksHtml(entry)}</details>
        </div>
      </details>`;
    }).join("") : '<p class="muted" style="font-size:12px">선택한 종류의 저장 이력이 없습니다.</p>'}`;
}

function entriesForDiff(kind: VersionHistoryKind, stage: string | null): VersionHistoryEntry[] {
  if (!history) return [];
  const matching = history.entries.filter((entry) => entry.kind === kind && (kind !== "translation" || entry.stage === stage));
  const current = matching.find((entry) => entry.isCurrent) ?? matching[0];
  if (!current) return [];
  return matching
    .filter((entry) => entry.aggregateId === current.aggregateId)
    .sort((left, right) => left.versionNo - right.versionNo || left.createdAt.localeCompare(right.createdAt));
}

function renderDiffControls(kind: VersionHistoryKind, stage: string | null): void {
  if (!history || !deps) return;
  const stages = [...new Set(history.entries.filter((entry) => entry.kind === "translation" && entry.stage).map((entry) => entry.stage!))];
  const resolvedStage = kind === "translation" ? (stage && stages.includes(stage) ? stage : stages[0] ?? null) : null;
  const entries = entriesForDiff(kind, resolvedStage);
  const target = entries.find((entry) => entry.isCurrent) ?? entries.at(-1);
  const base = (target?.parentVersionId ? entries.find((entry) => entry.versionId === target.parentVersionId) : null) ?? entries.at(-2);
  const option = (entry: VersionHistoryEntry) => `<option value="${deps!.escape(entry.versionId)}">v${entry.versionNo} · ${deps!.escape(stateLabel(entry))}</option>`;
  must("#diffCols").innerHTML = `
    <div style="grid-column:1/-1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;align-items:end">
      <div class="field"><label for="diffKind">종류</label><select class="select" id="diffKind">${(["source", "punctuation", "translation"] as const).map((value) => `<option value="${value}"${value === kind ? " selected" : ""}>${kindLabel(value)}</option>`).join("")}</select></div>
      <input type="hidden" id="diffStage" value="${deps!.escape(resolvedStage ?? "")}">
      <div class="field"><label for="diffBase">변경 전</label><select class="select" id="diffBase">${entries.map(option).join("")}</select></div>
      <div class="field"><label for="diffTarget">변경 후</label><select class="select" id="diffTarget">${entries.map(option).join("")}</select></div>
      <div class="row" style="grid-column:1/-1;justify-content:flex-end"><span class="muted" style="font-size:11.5px;margin-right:auto">비교할 두 버전을 선택하세요. 달라진 부분을 표시합니다.</span><button class="btn btn-primary" id="diffRun" type="button"${entries.length < 2 ? " disabled" : ""}>비교</button></div>
    </div>
    <div id="diffOutput" style="grid-column:1/-1" class="muted">${entries.length < 2 ? "비교할 이전 버전이 아직 없습니다." : "두 버전을 선택하고 비교를 누르세요."}</div>`;
  const baseSelect = must<HTMLSelectElement>("#diffBase");
  const targetSelect = must<HTMLSelectElement>("#diffTarget");
  if (base) baseSelect.value = base.versionId;
  if (target) targetSelect.value = target.versionId;
}

function renderDiffResult(diff: VersionDiffView): void {
  if (!deps) return;
  const before = diff.chunks.filter((chunk) => chunk.type !== "add").map((chunk) => `<span class="${chunk.type === "remove" ? "chg" : ""}">${deps!.escape(chunk.text)}</span>`).join("");
  const after = diff.chunks.filter((chunk) => chunk.type !== "remove").map((chunk) => `<span class="${chunk.type === "add" ? "chg" : ""}">${deps!.escape(chunk.text)}</span>`).join("");
  must("#diffOutput").innerHTML = `<div class="diff-cols">
    <div><div class="muted" style="font-size:11.5px;margin-bottom:6px">변경 전 · v${diff.base.versionNo}</div><div style="white-space:pre-wrap">${before || '<span class="muted">빈 내용</span>'}</div></div>
    <div><div class="muted" style="font-size:11.5px;margin-bottom:6px">변경 후 · v${diff.target.versionNo}</div><div style="white-space:pre-wrap">${after || '<span class="muted">빈 내용</span>'}</div></div>
  </div>`;
}

async function runDiff(): Promise<void> {
  if (!deps || !history) return;
  const kind = must<HTMLSelectElement>("#diffKind").value as VersionHistoryKind;
  const stage = kind === "translation" ? must<HTMLSelectElement>("#diffStage").value : null;
  const button = must<HTMLButtonElement>("#diffRun");
  button.disabled = true;
  button.textContent = "비교 중…";
  const result = await deps.api.editor.compareVersions({
    documentNodeId: history.documentNodeId,
    kind,
    stage,
    baseVersionId: must<HTMLSelectElement>("#diffBase").value,
    targetVersionId: must<HTMLSelectElement>("#diffTarget").value,
  });
  button.disabled = false;
  button.textContent = "비교";
  if (!result.ok) {
    deps.notify(result.error.message, "변경 비교");
    return;
  }
  renderDiffResult(result.data);
}

export function configureVersionHistoryUi(next: HistoryUiDeps): void {
  deps = next;
  const root = document.querySelector("#histList");
  if (root && !root.getAttribute("data-history-bound")) {
    root.setAttribute("data-history-bound", "1");
    root.addEventListener("change", (event) => {
      const element = event.target as HTMLSelectElement;
      if (element.matches("[data-history-kind]")) selectedKind = element.value as VersionHistoryKind;
      if (element.matches("[data-history-stage]")) selectedStage = element.value;
      render();
    });
    root.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("[data-history-compare]")) openVersionDiff(selectedKind, selectedStage);
    });
  }
  const cols = document.querySelector("#diffCols");
  if (cols && !cols.getAttribute("data-diff-bound")) {
    cols.setAttribute("data-diff-bound", "1");
    cols.addEventListener("change", (event) => {
      const element = event.target as HTMLSelectElement;
      if (element.id === "diffKind") {
        const kind = must<HTMLSelectElement>("#diffKind").value as VersionHistoryKind;
        renderDiffControls(kind, kind === "translation" ? selectedStage : null);
      }
    });
    cols.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("#diffRun")) void runDiff();
    });
  }
}

export async function loadVersionHistory(
  documentNodeId: string,
  preferredKind: VersionHistoryKind,
  preferredStage?: string | null,
): Promise<void> {
  if (!deps) return;
  selectedKind = preferredKind;
  if (preferredStage) selectedStage = preferredStage;
  loadingDocumentId = documentNodeId;
  const currentRequest = ++requestNo;
  render();
  const result = await deps.api.editor.getHistory(documentNodeId);
  if (currentRequest !== requestNo) return;
  loadingDocumentId = null;
  if (!result.ok) {
    history = null;
    deps.notify(result.error.message, "변경 이력");
  } else {
    history = result.data;
  }
  render();
}

export function renderVersionHistory(preferredKind?: VersionHistoryKind, preferredStage?: string | null): void {
  if (preferredKind) selectedKind = preferredKind;
  if (preferredStage) selectedStage = preferredStage;
  render();
}

export function openVersionDiff(kind: VersionHistoryKind, stage?: string | null, compareImmediately = false): void {
  if (loadingDocumentId && history?.documentNodeId !== loadingDocumentId) {
    deps?.notify("저장 이력을 불러오는 중입니다", "변경 비교");
    return;
  }
  if (!history || history.entries.length < 2) {
    deps?.notify("비교할 저장 이력이 없습니다", "변경 비교");
    return;
  }
  renderDiffControls(kind, stage ?? null);
  must<HTMLDialogElement>("#dlgDiff").showModal();
  if (compareImmediately && !must<HTMLButtonElement>("#diffRun").disabled) void runDiff();
}
