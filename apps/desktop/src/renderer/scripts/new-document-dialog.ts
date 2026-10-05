import { t, uiText, ui } from "./i18n";
import type { DocumentNodeRole } from "../../shared/munhae-api";
import { documentPathText } from "./knowledge-model";
import { go, must, notify, requireApi, unwrap } from "./shared";

// The entry point (sidebar menu, context menu, command) already chose what to
// create and where, so the dialog only asks for a name. Source text is entered
// in the editor's source step afterwards; an imported file is carried along.
let opening = false;
let submitting = false;
let role: DocumentNodeRole = "source_unit";
let parentId: string | null = null;
let importedText: string | null = null;

function ensureDialog(): void {
  if (document.querySelector("#dlgNew")) return;
  document.body.insertAdjacentHTML("beforeend", uiText(`<dialog id="dlgNew" class="sb-action-dialog" data-od-id="dialog-new-doc" aria-labelledby="ndHeading">
  <form method="dialog" id="newForm">
    <div class="dl-h" id="ndHeading">새 문서</div>
    <div class="dl-b">
      <p class="sb-action-path" id="ndPath"></p>
      <div class="field"><label for="ndTitle">제목</label><input class="input" id="ndTitle" maxlength="500" required placeholder="예: 서문" autocomplete="off"></div>
    </div>
    <div class="dl-f"><button class="btn" type="button" id="newCancel">취소</button><button class="btn btn-primary" id="newSubmit" type="submit">만들기</button></div>
  </form>
</dialog>`));
  must("#newCancel").addEventListener("click", () => {
    if (!submitting) must<HTMLDialogElement>("#dlgNew").close();
  });
  must("#dlgNew").addEventListener("cancel", (event) => {
    if (submitting) event.preventDefault();
  });
  must<HTMLFormElement>("#newForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
}

async function submit(): Promise<void> {
  if (submitting) return;
  const title = must<HTMLInputElement>("#ndTitle").value.trim();
  if (!title) return;
  submitting = true;
  must<HTMLButtonElement>("#newSubmit").disabled = true;
  try {
    const base = { title, originalTitle: null, parentId };
    const result = await requireApi().home.createDocument(
      role === "container"
        ? { ...base, nodeRole: "container" }
        : { ...base, nodeRole: "source_unit", originKind: importedText == null ? "manual" : "import", sourceText: importedText ?? "" },
    );
    const item = unwrap(result, t("새 문서"));
    if (!item) return;
    must<HTMLDialogElement>("#dlgNew").close();
    const refreshed = await requireApi().home.get();
    if (refreshed.ok) {
      window.dispatchEvent(new CustomEvent("munhae:document-created", { detail: refreshed.data }));
    } else { notify(refreshed.error.message, t("문서 목록 갱신")); }
    if (item.nodeRole === "source_unit") go("editor", item.id);
    else notify(ui`${title} 목차 폴더를 만들었습니다`, t("새 항목"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("항목을 만들지 못했습니다"), t("새 항목"));
  } finally {
    submitting = false;
    must<HTMLButtonElement>("#newSubmit").disabled = false;
  }
}

export async function openNewDocument(requestedParentId: string | null = null, nextRole: DocumentNodeRole = "source_unit", importText = false): Promise<void> {
  ensureDialog();
  const dialog = must<HTMLDialogElement>("#dlgNew");
  if (dialog.open || opening || submitting) return;
  opening = true;
  try {
    const result = await requireApi().home.get();
    if (!result.ok) { notify(result.error.message, t("새 항목")); return; }
    importedText = null;
    if (importText) {
      const picked = await requireApi().home.pickTextFile();
      if (!picked.ok) { notify(picked.error.message, t("가져오기")); return; }
      if (picked.data == null) return;
      importedText = picked.data;
    }
    const docs = result.data.documents;
    const masterId = docs.find((d) => d.isMaster)?.id ?? null;
    const requested = docs.find((d) => d.id === requestedParentId);
    parentId = requested?.nodeRole === "container"
      ? requested.id
      : requested?.parentId ?? masterId;
    role = importText ? "source_unit" : nextRole;
    must("#ndHeading").textContent = importText ? t("원문 가져오기") : role === "container" ? t("새 폴더") : t("새 문서");
    const path = parentId ? documentPathText(docs, parentId) : "";
    must("#ndPath").textContent = importedText == null
      ? path
      : ui`${path} · 원문 ${Array.from(importedText).length.toLocaleString()}자`;
    const titleInput = must<HTMLInputElement>("#ndTitle");
    titleInput.value = "";
    titleInput.placeholder = role === "container" ? t("예: 제1권") : t("예: 서문");
    dialog.showModal();
    titleInput.focus();
  } catch (error) {
    notify(error instanceof Error ? error.message : t("새 항목 창을 열지 못했습니다"), t("새 항목"));
  } finally { opening = false; }
}
