import type { CreateDocumentInput, DocumentNodeRole, HomeView } from "../../shared/munhae-api";
import { esc, must, notify, requireApi, unwrap } from "./shared";

let view: HomeView | null = null;
let opening = false;
let submitting = false;

function ensureDialog(): void {
  if (document.querySelector("#dlgNew")) return;
  document.body.insertAdjacentHTML("beforeend", `<dialog id="dlgNew" data-od-id="dialog-new-doc" aria-label="새 항목">
  <form method="dialog" id="newForm">
    <div class="dl-h">새 항목</div>
    <div class="dl-b">
      <div class="field"><label>역할</label>
        <div class="radio-list">
          <label><input type="radio" name="nodeRole" value="source_unit" checked> 원문 문서 <span class="muted">— 원문·표점·번역 작업</span></label>
          <label><input type="radio" name="nodeRole" value="container"> 목차 폴더 <span class="muted">— 하위 항목·문맥 정리</span></label>
        </div>
      </div>
      <div class="field"><label for="ndTitle">제목</label><input class="input" id="ndTitle" required placeholder="예: 서문" style="font-size:14px"></div>
      <div class="field"><label for="ndOriginal">원제 (선택)</label><input class="input hanmun" id="ndOriginal" placeholder="예: 御製序" style="font-size:14px"></div>
      <div class="field"><label for="nParent">상위 항목</label><select class="select" id="nParent"></select></div>
      <div id="ndSourceFields">
        <div class="field"><label>원문</label>
          <div class="radio-list">
            <label><input type="radio" name="origin" value="paste" checked> 붙여넣기</label>
            <label><input type="radio" name="origin" value="manual"> 직접 입력</label>
            <label><input type="radio" name="origin" value="import"> 텍스트 파일 가져오기</label>
          </div>
        </div>
        <div class="field" id="ndTextWrap"><label for="ndText">원문 내용</label>
          <textarea class="textarea hanmun" id="ndText" placeholder="원문을 붙여넣거나 입력하세요. 먼저 원문안만 만들어집니다." style="min-height:96px"></textarea>
          <button class="btn btn-sm" type="button" id="ndPickFile" style="margin-top:6px;align-self:flex-start">파일 선택…</button>
        </div>
      </div>
      <p class="muted" id="ndRoleHelp" style="font-size:12px">원문 문서는 하위 항목을 가질 수 없습니다. 원문안을 확정한 뒤 표점 원문을 별도로 만듭니다.</p>
    </div>
    <div class="dl-f"><button class="btn" value="cancel" type="button" id="newCancel">취소</button><button class="btn btn-primary" id="newSubmit" type="submit">원문 문서 만들기</button></div>
  </form>
</dialog>`);
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
        const originRaw =
          (document.querySelector('input[name="origin"]:checked') as HTMLInputElement | null)?.value ?? "paste";
        const sourceText = must<HTMLTextAreaElement>("#ndText").value;
        const originKind: "paste" | "manual" | "import" =
          originRaw === "import" ? "import" : originRaw === "manual" ? "manual" : "paste";
        if (nodeRole === "source_unit" && !sourceText.trim()) {
          notify("원문 문서에는 원문 내용이 필요합니다", "새 항목");
          return;
        }
        const base = { title, originalTitle: originalTitle || null, parentId };
        const input: CreateDocumentInput =
          nodeRole === "container"
            ? { ...base, nodeRole }
            : { ...base, nodeRole, originKind, sourceText };
        const result = await requireApi().home.createDocument(input);
        const item = unwrap(result, "새 문서");
        if (!item) return;
        (must("#dlgNew") as HTMLDialogElement).close();
        must<HTMLFormElement>("#newForm").reset();
        setNewNodeRole("source_unit");
        notify(
          nodeRole === "source_unit" ? `${title} 원문 문서를 만들었습니다` : `${title} 목차 폴더를 만들었습니다`,
          "새 항목",
        );
        const refreshed = await requireApi().home.get();
        if (refreshed.ok) {
          window.dispatchEvent(new CustomEvent("munhae:document-created", { detail: refreshed.data }));
        } else { notify(refreshed.error.message, "문서 목록 갱신"); }
      } catch (error) {
        notify(error instanceof Error ? error.message : "항목을 만들지 못했습니다", "새 항목");
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
          `${"  ".repeat(d.depth)}${d.originalTitle || d.title}${d.isMaster ? " (프로젝트 마스터)" : ""}`,
        )}</option>`,
    )
    .join("");
  const selected = preferred && docs.some((d) => d.id === preferred && d.nodeRole === "container")
    ? preferred
    : master?.id;
  if (selected) selEl.value = selected;
}

function setNewNodeRole(role: DocumentNodeRole): void {
  const roleInput = document.querySelector(`input[name="nodeRole"][value="${role}"]`) as HTMLInputElement | null;
  if (roleInput) roleInput.checked = true;
  must("#ndSourceFields").hidden = role === "container";
  must<HTMLTextAreaElement>("#ndText").required = role === "source_unit";
  must("#ndRoleHelp").textContent =
    role === "container"
      ? "목차 폴더는 하위 항목과 문맥만 정리하며 원문·표점·번역안을 가질 수 없습니다."
      : "원문 문서는 하위 항목을 가질 수 없습니다. 먼저 원문안만 만들고, 확정한 뒤 표점 원문을 별도로 만듭니다.";
  must("#newSubmit").textContent = role === "container" ? "목차 폴더 만들기" : "원문 문서 만들기";
}

export async function openNewDocument(parentId: string | null = null, role: DocumentNodeRole = "source_unit", importText = false): Promise<void> {
  ensureDialog();
  const dialog = must<HTMLDialogElement>("#dlgNew");
  if (dialog.open || opening || submitting) return;
  opening = true;
  try {
    const result = await requireApi().home.get();
    if (!result.ok) { notify(result.error.message, "새 항목"); return; }
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
    notify(error instanceof Error ? error.message : "새 항목 창을 열지 못했습니다", "새 항목");
  } finally { opening = false; }
}

async function pickSourceTextForNewDocument(): Promise<void> {
  const picked = document.querySelector('input[name="origin"][value="import"]') as HTMLInputElement | null;
  if (picked) picked.checked = true;
  const result = await requireApi().home.pickTextFile();
  if (!result.ok) {
    notify(result.error.message, "가져오기");
    return;
  }
  if (result.data == null) return;
  must<HTMLTextAreaElement>("#ndText").value = result.data;
  notify("파일을 읽었습니다. 문서 만들기를 누르면 저장됩니다", "가져오기");
}
