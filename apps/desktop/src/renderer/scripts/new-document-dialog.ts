import { t, uiText, ui } from "./i18n";
import type { CreateDocumentInput, DocumentNodeRole, HomeView } from "../../shared/munhae-api";
import { esc, must, notify, requireApi, unwrap } from "./shared";

let view: HomeView | null = null;
let opening = false;
let submitting = false;
let sourceOrigin: "paste" | "manual" | "import" = "manual";

function ensureDialog(): void {
  if (document.querySelector("#dlgNew")) return;
  document.body.insertAdjacentHTML("beforeend", uiText(`<dialog id="dlgNew" data-od-id="dialog-new-doc" aria-labelledby="ndHeading">
  <form method="dialog" id="newForm">
    <div class="dl-h" id="ndHeading">새 원문</div>
    <div class="dl-b">
      <fieldset class="nd-kind"><legend class="sr-only">만들 항목</legend>
        <label><input type="radio" name="nodeRole" value="source_unit" checked><span>원문</span></label>
        <label><input type="radio" name="nodeRole" value="container"><span>폴더</span></label>
      </fieldset>
      <div class="field"><label for="ndTitle">제목</label><input class="input" id="ndTitle" required placeholder="예: 서문" autocomplete="off"></div>
      <div id="ndSourceFields">
        <div class="field" id="ndTextWrap">
          <div class="nd-source-head"><label for="ndText">원문</label><button class="btn btn-ghost btn-sm" type="button" id="ndPickFile">텍스트 파일 가져오기</button></div>
          <textarea class="textarea hanmun" id="ndText" placeholder="원문을 붙여넣거나 입력하세요."></textarea>
        </div>
      </div>
      <details class="nd-options" id="ndOptions"><summary>추가 정보 <span id="ndParentSummary"></span></summary>
        <div class="nd-options-fields">
          <div class="field"><label for="ndOriginal">원제 <span class="muted">(선택)</span></label><input class="input hanmun" id="ndOriginal" placeholder="예: 御製序"></div>
          <div class="field"><label for="nParent">위치</label><select class="select" id="nParent"></select></div>
        </div>
      </details>
    </div>
    <div class="dl-f"><button class="btn" value="cancel" type="button" id="newCancel">취소</button><button class="btn btn-primary" id="newSubmit" type="submit">원문 만들기</button></div>
  </form>
</dialog>`));
  must("#newCancel").addEventListener("click", () => {
    if (!submitting) must<HTMLDialogElement>("#dlgNew").close();
  });
  must("#dlgNew").addEventListener("cancel", (event) => {
    if (submitting) event.preventDefault();
  });
  document.querySelectorAll<HTMLInputElement>('input[name="nodeRole"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) setNewNodeRole(input.value as DocumentNodeRole);
    });
  });
  must("#ndText").addEventListener("paste", () => { sourceOrigin = "paste"; });
  must("#nParent").addEventListener("change", updateParentSummary);
  must("#ndPickFile").addEventListener("click", () => void pickSourceTextForNewDocument());
  must<HTMLFormElement>("#newForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void (async () => {
      if (submitting) return;
      submitting = true;
      must<HTMLButtonElement>("#newSubmit").disabled = true;
      try {
        const title = must<HTMLInputElement>("#ndTitle").value.trim();
        if (!title) return;
        const originalTitle = must<HTMLInputElement>("#ndOriginal").value.trim();
        const parentId = must<HTMLSelectElement>("#nParent").value || null;
        const nodeRole =
          (document.querySelector('input[name="nodeRole"]:checked') as HTMLInputElement | null)?.value === "container"
            ? "container"
            : "source_unit";
        const sourceText = must<HTMLTextAreaElement>("#ndText").value;
        const originKind = sourceOrigin;
        if (nodeRole === "source_unit" && !sourceText.trim()) {
          notify(t("원문 문서에는 원문 내용이 필요합니다"), t("새 항목"));
          return;
        }
        const base = { title, originalTitle: originalTitle || null, parentId };
        const input: CreateDocumentInput =
          nodeRole === "container"
            ? { ...base, nodeRole }
            : { ...base, nodeRole, originKind, sourceText };
        const result = await requireApi().home.createDocument(input);
        const item = unwrap(result, t("새 문서"));
        if (!item) return;
        (must("#dlgNew") as HTMLDialogElement).close();
        must<HTMLFormElement>("#newForm").reset();
        sourceOrigin = "manual";
        must<HTMLDetailsElement>("#ndOptions").open = false;
        setNewNodeRole("source_unit");
        notify(
          nodeRole === "source_unit" ? ui`${title} 원문 문서를 만들었습니다` : ui`${title} 목차 폴더를 만들었습니다`,
          t("새 항목"),
        );
        const refreshed = await requireApi().home.get();
        if (refreshed.ok) {
          window.dispatchEvent(new CustomEvent("munhae:document-created", { detail: refreshed.data }));
        } else { notify(refreshed.error.message, t("문서 목록 갱신")); }
      } catch (error) {
        notify(error instanceof Error ? error.message : t("항목을 만들지 못했습니다"), t("새 항목"));
      } finally {
        submitting = false;
        must<HTMLButtonElement>("#newSubmit").disabled = false;
      }
    })();
  });

}

function fillParents(preferred: string | null = null): void {
  const selEl = must<HTMLSelectElement>("#nParent");
  const docs = view?.documents ?? [];
  const master = docs.find((d) => d.isMaster);
  selEl.innerHTML = docs
    .filter((d) => d.nodeRole === "container")
    .map(
      (d) =>
        `<option value="${esc(d.id)}">${esc(
          `${"  ".repeat(d.depth)}${d.originalTitle || d.title}${d.isMaster ? t(" (프로젝트 마스터)") : ""}`,
        )}</option>`,
    )
    .join("");
  const selected = preferred && docs.some((d) => d.id === preferred && d.nodeRole === "container")
    ? preferred
    : master?.id;
  if (selected) selEl.value = selected;
  updateParentSummary();
}

function updateParentSummary(): void {
  const select = must<HTMLSelectElement>("#nParent");
  const parent = view?.documents.find(d => d.id === select.value);
  must("#ndParentSummary").textContent = parent ? ui`위치: ${parent.originalTitle || parent.title}` : t("프로젝트 안에 만들기");
}

function setNewNodeRole(role: DocumentNodeRole): void {
  const roleInput = document.querySelector(`input[name="nodeRole"][value="${role}"]`) as HTMLInputElement | null;
  if (roleInput) roleInput.checked = true;
  must("#ndSourceFields").hidden = role === "container";
  must<HTMLTextAreaElement>("#ndText").required = role === "source_unit";
  must("#ndHeading").textContent = role === "container" ? t("새 폴더") : t("새 원문");
  must<HTMLInputElement>("#ndTitle").placeholder = role === "container" ? t("예: 제1권") : t("예: 서문");
  must("#newSubmit").textContent = role === "container" ? t("폴더 만들기") : t("원문 만들기");
}

export async function openNewDocument(parentId: string | null = null, role: DocumentNodeRole = "source_unit", importText = false): Promise<void> {
  ensureDialog();
  const dialog = must<HTMLDialogElement>("#dlgNew");
  if (dialog.open || opening || submitting) return;
  opening = true;
  try {
    const result = await requireApi().home.get();
    if (!result.ok) { notify(result.error.message, t("새 항목")); return; }
    view = result.data;
    const masterId = view?.documents.find((d) => d.isMaster)?.id ?? null;
    const requestedParent = view?.documents.find((d) => d.id === parentId);
    const resolvedParentId = requestedParent?.nodeRole === "source_unit"
      ? requestedParent.parentId ?? masterId
      : parentId ?? masterId;
    fillParents(resolvedParentId);
    setNewNodeRole(role);
    (must("#dlgNew") as HTMLDialogElement).showModal();
    must<HTMLInputElement>("#ndTitle").focus();
    if (importText) await pickSourceTextForNewDocument();
  } catch (error) {
    notify(error instanceof Error ? error.message : t("새 항목 창을 열지 못했습니다"), t("새 항목"));
  } finally { opening = false; }
}

async function pickSourceTextForNewDocument(): Promise<void> {
  const result = await requireApi().home.pickTextFile();
  if (!result.ok) {
    notify(result.error.message, t("가져오기"));
    return;
  }
  if (result.data == null) return;
  sourceOrigin = "import";
  must<HTMLTextAreaElement>("#ndText").value = result.data;
  notify(t("파일을 읽었습니다. 문서 만들기를 누르면 저장됩니다"), t("가져오기"));
}
