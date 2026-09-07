import type { ItkcFootnote, ItkcFootnoteSearchInput, ItkcFootnoteSearchResult, MunhaeApi } from "../../shared/munhae-api";
import { footnoteCitation } from "./footnote-citation";
import "../styles/footnote-search.css";

type SearchContext = { query?: string; quote?: string; insert?: (note: ItkcFootnote) => void };

export function configureFootnoteSearch(api: MunhaeApi, escape: (value: unknown) => string) {
  const el = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`missing ${id}`);
    return element as T;
  };
  const dialog = el<HTMLDialogElement>("dlgFootnoteSearch");
  const query = el<HTMLInputElement>("footnoteQuery");
  const mode = el<HTMLSelectElement>("footnoteSearchMode");
  let context: SearchContext = {};
  let result: ItkcFootnoteSearchResult | null = null;
  let selected = 0;
  let loading = false;
  let request = 0;

  function selectedNote(): ItkcFootnote | undefined { return result?.items[selected]; }
  function error(message: string): void {
    el("footnoteSearchError").textContent = message;
    el("footnoteSearchError").hidden = !message;
  }
  function renderHelp(): void {
    el("footnoteSearchHelp").textContent = mode.value === "target"
      ? "각주가 붙은 표현에서 찾습니다. 한문 표현은 한국어 번역어로도 바꿔 찾아보세요."
      : "각주 대상과 설명을 함께 검색합니다. 검색어가 대상 구절에 없는 결과도 나올 수 있습니다.";
  }
  function renderDetail(): void {
    const note = selectedNote();
    el<HTMLButtonElement>("footnoteCopy").disabled = loading || !note;
    el<HTMLButtonElement>("footnoteInsert").disabled = loading || !note;
    el("footnoteInsert").hidden = !context.insert;
    for (const button of el("footnoteResultsList").querySelectorAll<HTMLButtonElement>("[data-footnote-index]")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.footnoteIndex) === selected));
    }
    if (!note) {
      el("footnoteDetail").innerHTML = `<p class="muted">${loading ? "각주 자료를 불러오고 있습니다." : "각주 대상 구절과 설명, 출처를 함께 확인할 수 있습니다."}</p>`;
      return;
    }
    const metadata = [["서명", note.bookTitle], ["역자", note.translator], ["간행처", note.publisher], ["간행년도", note.year]]
      .filter(([, value]) => value).map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join("");
    el("footnoteDetail").innerHTML = `<p class="footnote-label">각주 대상 구절</p><h3>${escape(note.annotatedText)}</h3>
      ${note.displayTitle && note.displayTitle !== note.annotatedText ? `<p class="footnote-display-title">표시 제목 · ${escape(note.displayTitle)}</p>` : ""}
      <p class="footnote-label">각주 설명</p><div class="footnote-body">${escape(note.bodyText || "제공된 각주 설명이 없습니다.")}</div>
      <dl class="footnote-bibliography">${metadata}</dl>
      <button class="btn btn-sm" type="button" id="footnoteOpenSource">한국고전종합DB에서 보기 ↗</button>
      <p class="footnote-origin-note">다른 문헌의 용례입니다. 현재 구절과 문맥이 맞는지 확인한 뒤 활용하세요.</p>`;
    el("footnoteDetail").scrollTop = 0;
  }
  function render(): void {
    el("footnoteResults").setAttribute("aria-busy", String(loading));
    el<HTMLButtonElement>("footnotePrevious").disabled = loading || !result || result.start === 0;
    el<HTMLButtonElement>("footnoteNext").disabled = loading || !result?.hasMore;
    el<HTMLButtonElement>("footnoteSearchSubmit").textContent = loading ? "다시 검색" : "검색";
    const items = result?.items ?? [];
    el("footnoteResultsList").innerHTML = items.map((note, index) => `<li><button type="button" data-footnote-index="${index}" aria-pressed="${index === selected}"${loading ? " disabled" : ""}>
      <strong>${escape(note.annotatedText || note.displayTitle)}</strong><span class="footnote-result-book">${escape(note.bookTitle || "서명 정보 없음")}</span><span class="footnote-preview">${escape(Array.from(note.bodyText).slice(0, 130).join(""))}${Array.from(note.bodyText).length > 130 ? "…" : ""}</span></button></li>`).join("");
    el("footnoteSearchStatus").textContent = loading ? "한국고전종합DB에서 검색 중…" : result
      ? result.total ? `‘${result.query}’ · ${result.total.toLocaleString()}건 중 ${result.start + 1}–${result.start + items.length} · ${result.mode === "target" ? "각주 대상 구절" : "대상·설명 전체"}`
        : `‘${result.query}’ 검색 결과가 없습니다. 검색어를 짧게 바꾸거나 검색 범위를 넓혀 보세요.`
      : "검색어를 입력해 각주 용례를 찾아보세요.";
    renderDetail();
  }

  async function search(input: ItkcFootnoteSearchInput): Promise<void> {
    const current = ++request;
    loading = true;
    result = null;
    selected = 0;
    error("");
    el("footnoteActionStatus").textContent = "";
    render();
    try {
      const response = await api.research.searchFootnotes(input);
      if (current !== request || !dialog.open) return;
      if (!response.ok) throw new Error(response.error.message);
      result = response.data;
    } catch (cause) {
      if (current === request && dialog.open) error(cause instanceof Error ? cause.message : "각주 검색에 실패했습니다. 다시 검색해 주세요.");
    } finally {
      if (current === request) { loading = false; render(); }
    }
  }

  function open(next: SearchContext = {}): void {
    context = next;
    if (next.query !== undefined) {
      const value = Array.from(next.query.trim()).slice(0, 100).join("");
      if (query.value !== value || mode.value !== "target" || (result && (result.query !== value || result.mode !== "target"))) {
        result = null;
        selected = 0;
      }
      query.value = value;
      mode.value = "target";
    }
    ++request;
    loading = false;
    error("");
    el("footnoteActionStatus").textContent = "";
    el("footnoteContext").hidden = !next.quote;
    el("footnoteContext").textContent = next.quote ? `검토 중인 구절 · ${next.quote}` : "";
    renderHelp();
    render();
    if (!dialog.open) dialog.showModal();
    query.focus();
    query.select();
  }

  el("footnoteSearchForm").addEventListener("submit", event => {
    event.preventDefault();
    void search({ query: query.value, mode: mode.value === "content" ? "content" : "target", start: 0 });
  });
  mode.addEventListener("change", renderHelp);
  el("footnotePrevious").addEventListener("click", () => {
    if (result && !loading) void search({ query: result.query, mode: result.mode, start: Math.max(0, result.start - result.pageSize) });
  });
  el("footnoteNext").addEventListener("click", () => {
    if (result?.hasMore && !loading) void search({ query: result.query, mode: result.mode, start: result.start + result.pageSize });
  });
  el("footnoteResultsList").addEventListener("click", event => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-footnote-index]");
    if (!button || loading) return;
    selected = Number(button.dataset.footnoteIndex);
    el("footnoteActionStatus").textContent = "";
    renderDetail();
  });
  el("footnoteDetail").addEventListener("click", event => {
    if (!(event.target as HTMLElement).closest("#footnoteOpenSource")) return;
    const note = selectedNote();
    const current = request;
    if (note) void api.app.openExternal(note.sourceUrl).catch(cause => {
      if (dialog.open && current === request) error(cause instanceof Error ? cause.message : "DB 링크를 열지 못했습니다.");
    });
  });
  el("footnoteCopy").addEventListener("click", () => {
    const note = selectedNote();
    const current = request;
    if (note) void navigator.clipboard.writeText(footnoteCitation(note)).then(() => {
      if (dialog.open && current === request) el("footnoteActionStatus").textContent = "출처와 함께 복사했습니다.";
    }).catch(() => {
      if (dialog.open && current === request) error("클립보드에 복사하지 못했습니다. 다시 시도해 주세요.");
    });
  });
  el("footnoteInsert").addEventListener("click", () => {
    const note = selectedNote();
    if (!note || !context.insert || loading) return;
    try { context.insert(note); dialog.close(); }
    catch (cause) { error(cause instanceof Error ? cause.message : "코멘트에 자료를 넣지 못했습니다."); }
  });
  el("footnoteCloseTop").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    ++request;
    loading = false;
    context = {};
  });
  return { open, closeAttached: () => { if (dialog.open && context.insert) dialog.close(); } };
}
