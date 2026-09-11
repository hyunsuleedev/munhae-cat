import type { ConcordanceInput, ConcordanceResult, ConcordanceView, MunhaeApi } from "../../shared/munhae-api";
import "../styles/concordance.css";

type Options = {
  api: MunhaeApi;
  escape: (value: unknown) => string;
  notify: (message: string, title?: string) => void;
  currentDocumentId: () => string | null;
  openDocument: (id: string, sentenceId?: string | null, translationVersionId?: string | null) => void | Promise<void>;
};

export function configureConcordance({ api, escape, notify, currentDocumentId, openDocument }: Options) {
  const dialog = document.createElement("dialog");
  dialog.id = "dlgConcordance";
  dialog.className = "concordance-dialog";
  dialog.setAttribute("aria-labelledby", "concordanceTitle");
  dialog.innerHTML = `<div class="concordance-head"><div><p class="concordance-eyebrow">현재 프로젝트의 저장된 원문과 번역</p><h2 id="concordanceTitle">번역 용례 대조</h2></div><button class="btn btn-ghost btn-sm" type="button" id="concordanceClose">닫기 <kbd>Esc</kbd></button></div>
    <form id="concordanceForm" class="concordance-form">
      <div class="concordance-query"><label for="concordanceQuery">검색어 <span>최대 100자</span></label><input id="concordanceQuery" class="input" maxlength="200" autocomplete="off" placeholder="이전에 어떻게 번역했는지 찾아보세요" required></div>
      <div><label for="concordanceScope">검색 범위</label><select id="concordanceScope" class="input"><option value="all">원문·번역문</option><option value="source">원문</option><option value="translation">번역문</option></select></div>
      <div><label for="concordanceState">기준 버전</label><select id="concordanceState" class="input"><option value="current">현재 작업본</option><option value="confirmed">최근 확정본</option></select></div>
      <button class="btn btn-primary" type="submit" id="concordanceSubmit">검색</button>
    </form>
    <div class="concordance-options"><label><input id="concordanceCurrentDocument" type="checkbox"> 현재 문서만</label><p>입력한 구절 그대로 찾습니다. 저장한 원문 대응을 따라 번역을 함께 보여줍니다.</p></div>
    <p id="concordanceStatus" role="status" aria-live="polite" class="concordance-status">검색어를 입력하거나 편집 중 구절을 선택해 용례를 찾아보세요.</p>
    <p id="concordanceError" class="concordance-error" role="alert" hidden></p>
    <div id="concordanceResults" class="concordance-results" aria-label="번역 용례 검색 결과"></div>
    <div class="concordance-footer"><span id="concordanceLimitHint"></span><button id="concordanceMore" class="btn btn-sm" type="button" hidden>최대 100건 보기</button></div>`;
  document.body.append(dialog);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const query = el<HTMLInputElement>("concordanceQuery");
  const scope = el<HTMLSelectElement>("concordanceScope");
  const state = el<HTMLSelectElement>("concordanceState");
  const currentOnly = el<HTMLInputElement>("concordanceCurrentDocument");
  let result: ConcordanceView | null = null;
  let lastInput: ConcordanceInput | null = null;
  let serial = 0;
  let loading = false;
  const highlight = (text: string, term: string) => term ? text.split(term).map(escape).join(`<mark>${escape(term)}</mark>`) : escape(text);
  const versionState = (row: ConcordanceResult) => row.translationVersionId
    ? row.isConfirmed ? "확정" : row.translationState === "draft" ? "초안" : row.translationState === "superseded" ? "이전 번역" : "검토 중"
    : row.isConfirmed ? "확정 원문" : "원문";
  function render(): void {
    const rows = result?.results ?? [];
    el("concordanceResults").setAttribute("aria-busy", String(loading));
    el<HTMLButtonElement>("concordanceSubmit").disabled = loading;
    el<HTMLButtonElement>("concordanceMore").disabled = loading;
    el("concordanceMore").hidden = !result?.hasMore || (lastInput?.limit ?? 50) >= 100;
    el("concordanceLimitHint").textContent = result?.hasMore ? `앞의 ${rows.length}건을 표시합니다. 검색어 또는 범위를 좁히면 다른 용례를 찾을 수 있습니다.` : "";
    el("concordanceStatus").textContent = loading ? "프로젝트에서 용례를 찾고 있습니다…" : result
      ? rows.length ? `‘${result.query}’ · ${rows.length}건${result.hasMore ? " 이상" : ""} · ${result.state === "confirmed" ? "최근 확정본" : "현재 작업본"}`
        : `‘${result.query}’와 일치하는 용례가 없습니다. 검색어 또는 기준 버전을 바꿔보세요.`
      : "검색어를 입력하거나 편집 중 구절을 선택해 용례를 찾아보세요.";
    el("concordanceResults").innerHTML = rows.map((row, index) => {
      const provenance = row.contextKind === "document" ? row.translationVersionId ? "문서 전체 문맥 · 원문 대응 미확인" : "아직 번역이 없는 원문"
        : row.alignment === "human" ? "직접 확인한 대응" : row.needsReview ? "자동 대응 · 확인 필요" : "자동 대응";
      const version = `원문 V${row.sourceVersionNo}${row.translationVersionNo !== null ? ` · 번역 V${row.translationVersionNo}` : ""}`;
      return `<article class="concordance-result" data-concordance-id="${escape(row.id)}">
        <header><div><h3>${escape(row.documentTitle)}</h3><p>${escape(version)} <span class="concordance-version-state">${versionState(row)}</span>${!row.sourceIsCurrent ? '<span class="concordance-stale">이전 원문 기준</span>' : ""}${!row.isCurrent ? '<span class="concordance-stale">이전 버전</span>' : ""}</p></div>
        <button class="btn btn-ghost btn-sm" type="button" data-concordance-open="${index}">${row.isCurrent ? "문서에서 보기" : "현재 문서 열기"} ↗</button></header>
        <p class="concordance-provenance${row.needsReview ? " needs-review" : ""}">${provenance}${row.sentenceId ? ` · ${escape(row.sentenceId)}` : ""}</p>
        <div class="concordance-pair${row.contextKind === "document" ? " is-document-context" : ""}"><section aria-label="원문 용례"><span class="concordance-cell-label">원문${row.matchedIn.includes("source") ? " · 일치" : ""}</span><div class="concordance-source">${highlight(row.sourceText, result!.query)}</div></section><section aria-label="번역 용례"><span class="concordance-cell-label">번역문${row.matchedIn.includes("translation") ? " · 일치" : ""}</span><div>${row.translationText === null ? '<span class="muted">저장된 번역이 없습니다.</span>' : highlight(row.translationText, result!.query)}</div></section></div>
      </article>`;
    }).join("");
  }
  async function search(input: ConcordanceInput): Promise<void> {
    const request = ++serial;
    loading = true; result = null; lastInput = input;
    el("concordanceError").hidden = true;
    render();
    try {
      const response = await api.project.concordance(input);
      if (!dialog.open || request !== serial) return;
      if (!response.ok) throw new Error(response.error.message);
      result = response.data;
    } catch (cause) {
      if (!dialog.open || request !== serial) return;
      el("concordanceError").textContent = cause instanceof Error ? cause.message : "용례를 찾지 못했습니다. 다시 검색해 주세요.";
      el("concordanceError").hidden = false;
    } finally {
      if (request === serial) { loading = false; render(); }
    }
  }
  el("concordanceForm").addEventListener("submit", event => {
    event.preventDefault();
    const documentNodeId = currentOnly.checked ? currentDocumentId() : null;
    if (currentOnly.checked && !documentNodeId) { notify("현재 문서를 연 뒤 검색하세요", "번역 용례 대조"); return; }
    void search({ query: query.value, scope: scope.value as ConcordanceInput["scope"], state: state.value as ConcordanceInput["state"], documentNodeId, limit: 50 });
  });
  el("concordanceMore").addEventListener("click", () => { if (lastInput && !loading) void search({ ...lastInput, limit: 100 }); });
  el("concordanceClose").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => { ++serial; loading = false; });
  el("concordanceResults").addEventListener("click", event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-concordance-open]") : null;
    const row = target ? result?.results[Number(target.dataset.concordanceOpen)] : null;
    if (!row || loading || !target) return;
    target.disabled = true;
    void Promise.resolve().then(() => openDocument(row.documentNodeId, row.sentenceId, row.translationVersionId))
      .catch(cause => notify(cause instanceof Error ? cause.message : "문서를 열지 못했습니다", "번역 용례 대조"))
      .finally(() => { target.disabled = false; });
  });
  return {
    open(value?: string): void {
      ++serial; loading = false;
      const id = currentDocumentId();
      currentOnly.disabled = !id;
      if (!id) currentOnly.checked = false;
      if (lastInput?.documentNodeId && lastInput.documentNodeId !== id) result = null;
      if (value !== undefined) {
        const next = Array.from(value.trim()).slice(0, 100).join("");
        if (result?.query !== next) result = null;
        query.value = next;
      }
      el("concordanceError").hidden = true;
      render();
      if (!dialog.open) dialog.showModal();
      query.focus(); query.select();
    },
  };
}
