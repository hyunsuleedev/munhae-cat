import type { MunhaeApi, ReviewExportInput } from "../../shared/munhae-api";
import "../styles/review-export.css";

type Deps = {
  api: MunhaeApi;
  currentDocumentId(): string | null;
  beforeExport?(): boolean | Promise<boolean>;
  notify(message: string, title?: string): void;
};

export function configureReviewExport(deps: Deps): { open(): void } {
  const dialog = document.createElement("dialog");
  dialog.id = "dlgReviewExport";
  dialog.className = "review-export-dialog";
  dialog.setAttribute("aria-labelledby", "reviewExportTitle");
  dialog.innerHTML = `<form id="reviewExportForm">
    <div class="dl-h" id="reviewExportTitle">번역 검토본 내보내기</div>
    <div class="dl-b review-export-fields">
      <p class="review-export-intro">원문과 번역을 나란히 읽고, 선택 구절의 코멘트와 참고자료를 함께 검토할 수 있습니다.</p>
      <div class="field"><label for="reviewExportFormat">파일 형식</label><select class="select" id="reviewExportFormat"><option value="html">인쇄용 HTML — 브라우저에서 PDF 저장 가능</option><option value="markdown">Markdown (.md)</option></select></div>
      <div class="review-export-options">
        <div class="field"><label for="reviewExportScope">범위</label><select class="select" id="reviewExportScope"><option value="document">현재 문서</option><option value="project">프로젝트 전체</option></select></div>
        <div class="field"><label for="reviewExportState">번역 버전</label><select class="select" id="reviewExportState"><option value="current">현재 저장본 — 작업안 포함</option><option value="confirmed">확정본만</option></select></div>
      </div>
      <label class="check"><input id="reviewExportComments" type="checkbox" checked> 검토 코멘트와 참고자료 포함</label>
      <p class="muted review-export-help">원문·번역 전문과 문헌 정보도 포함합니다. 코멘트는 내보내는 번역 버전에 연결된 항목만 포함하며, 출판용 각주와 구분합니다.</p>
      <p id="reviewExportError" class="review-export-error" role="alert" hidden></p>
    </div>
    <div class="dl-f"><button class="btn" id="reviewExportClose" type="button">취소</button><button class="btn btn-primary" id="reviewExportSave" type="submit">저장 위치 선택…</button></div>
  </form>`;
  document.body.append(dialog);
  const el = <T extends HTMLElement>(selector: string): T => dialog.querySelector<T>(selector)!;
  const error = el<HTMLParagraphElement>("#reviewExportError");
  const save = el<HTMLButtonElement>("#reviewExportSave");
  const scope = el<HTMLSelectElement>("#reviewExportScope");
  let busy = false;
  let openedDocumentId: string | null = null;
  const close = () => { if (!busy) dialog.close(); };
  el("#reviewExportClose").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
  el<HTMLFormElement>("#reviewExportForm").addEventListener("submit", event => { event.preventDefault(); void run(); });
  function setBusy(value: boolean): void {
    busy = value;
    for (const control of dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button")) control.disabled = value;
    save.textContent = value ? "준비 중…" : "저장 위치 선택…";
    dialog.setAttribute("aria-busy", String(value));
  }
  async function run(): Promise<void> {
    if (busy) return;
    error.hidden = true;
    const input: ReviewExportInput = {
      format: el<HTMLSelectElement>("#reviewExportFormat").value as ReviewExportInput["format"],
      state: el<HTMLSelectElement>("#reviewExportState").value as ReviewExportInput["state"],
      documentNodeId: scope.value === "document" ? openedDocumentId : null,
      includeComments: el<HTMLInputElement>("#reviewExportComments").checked,
    };
    setBusy(true);
    try {
      if (scope.value === "document" && (!openedDocumentId || deps.currentDocumentId() !== openedDocumentId)) throw new Error("문서가 변경되었습니다. 검토본 내보내기를 다시 여세요.");
      if (deps.beforeExport && !await deps.beforeExport()) { error.textContent = "편집 중인 내용을 저장한 뒤 다시 내보내세요."; error.hidden = false; return; }
      const result = await deps.api.project.exportReview(input);
      if (!result.ok) throw new Error(result.error.message);
      if (!result.data) return;
      dialog.close();
      deps.notify(`${result.data.documentCount}개 문서의 검토본을 저장했습니다.\n${result.data.filePath}`, "검토본 내보내기");
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "검토본을 내보내지 못했습니다.";
      error.hidden = false;
    } finally { setBusy(false); }
  }
  return {
    open(): void {
      if (dialog.open || busy) return;
      openedDocumentId = deps.currentDocumentId();
      const documentOption = scope.querySelector<HTMLOptionElement>('option[value="document"]')!;
      documentOption.disabled = !openedDocumentId;
      scope.value = openedDocumentId ? "document" : "project";
      error.hidden = true;
      dialog.showModal();
      el<HTMLSelectElement>("#reviewExportFormat").focus();
    },
  };
}
