import { t, uiText, ui } from "./i18n";
import { checkTranslation, type CheckInput, type TranslationCheck } from "./translation-checks";
import "../styles/translator-tools.css";

export function configureTranslationChecks(deps: {
  snapshot(): CheckInput | null;
  escape(value: unknown): string;
  locate(issue: TranslationCheck): void;
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "translator-dialog";
  dialog.id = "dlgTranslationChecks";
  dialog.setAttribute("aria-labelledby", "translationChecksHeading");
  dialog.innerHTML = uiText(`<div class="translator-dialog-head"><h2 id="translationChecksHeading">번역 검토 목록</h2><button class="btn" data-close type="button">닫기</button></div>
    <p class="muted">자동 점검은 확인할 위치를 모아줍니다. 원문 누락이나 번역 오류인지 판단하려면 문맥을 대조하세요.</p>
    <p data-check-status role="status"></p><div class="translator-filters"><label>항목 <select class="select" data-check-filter><option value="">전체</option><option value="alignment">문장 대응</option><option value="coverage">미연결 원문</option><option value="term">용어</option><option value="text">문자·괄호</option><option value="comment">검토 코멘트</option></select></label><button class="btn" data-check-refresh type="button">다시 점검</button></div><div data-check-list class="translator-check-list"></div>`);
  document.body.append(dialog);
  let issues: TranslationCheck[] = [];
  let input: CheckInput | null = null;
  let limit = 200;
  const list = dialog.querySelector<HTMLElement>("[data-check-list]")!;
  const filter = dialog.querySelector<HTMLSelectElement>("[data-check-filter]")!;
  function render() {
    const visible = issues.map((issue, index) => ({ issue, index })).filter(({ issue }) => !filter.value || issue.kind === filter.value);
    dialog.querySelector("[data-check-status]")!.textContent = ui`${issues.length}개 확인 항목${input?.dirty ? t(" · 미저장 편집 기준 (코멘트 위치는 저장 후 확인)") : t(" · 현재 저장본 기준")}`;
    list.innerHTML = visible.length ? visible.slice(0, limit).map(({ issue, index }) => `<article class="translator-check"><div><b>${deps.escape(issue.title)}</b><p>${deps.escape(issue.detail)}</p></div>${issue.sentenceId || issue.target || issue.commentId ? ui`<button class="btn btn-sm" data-check-locate="${index}" type="button">위치 보기</button>` : ""}</article>`).join("") : uiText('<p class="muted">이 항목에서 발견된 점검 사항이 없습니다. 내용의 정확성은 원문과 대조해 검토하세요.</p>');
    if (visible.length > limit) list.insertAdjacentHTML("beforeend", ui`<button class="btn" data-check-more type="button">다음 200개 더 보기 (${visible.length - limit}개 남음)</button>`);
  }
  function refresh() { limit = 200; input = deps.snapshot(); issues = input ? checkTranslation(input) : []; render(); }
  dialog.querySelector("[data-close]")!.addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-check-refresh]")!.addEventListener("click", refresh);
  filter.addEventListener("change", render);
  list.addEventListener("click", event => {
    if ((event.target as HTMLElement).closest("[data-check-more]")) { limit += 200; render(); return; }
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-check-locate]");
    const issue = button && issues[Number(button.dataset.checkLocate)];
    if (issue) {
      if (JSON.stringify(input) !== JSON.stringify(deps.snapshot())) { refresh(); dialog.querySelector("[data-check-status]")!.textContent = t("문서가 변경되어 다시 점검했습니다. 확인할 항목을 다시 선택하세요."); return; }
      dialog.close(); deps.locate(issue);
    }
  });
  return { open() { refresh(); if (!dialog.open) dialog.showModal(); }, summary() { const data = deps.snapshot(); return data ? checkTranslation(data) : []; } };
}
