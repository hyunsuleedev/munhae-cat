import type { MaterialRefinementInput, MunhaeApi } from "../../shared/munhae-api";
import { t, ui } from "./i18n";
import "../styles/material-refinement.css";

export function configureMaterialRefinement(api: MunhaeApi) {
  const dialog = document.createElement("dialog");
  dialog.className = "material-refinement-dialog";
  dialog.setAttribute("aria-label", t("문맥 노트 AI"));
  document.body.append(dialog);
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  let input: MaterialRefinementInput;
  let apply: (text: string) => boolean;
  let opener: HTMLElement | null = null;
  let generation = 0;
  let runId: string | null = null;
  let busy = false;
  let conversation: Array<{ role: "user" | "assistant"; content: string }> = [];
  let timer: number | undefined;
  function setBusy(value: boolean) {
    busy = value;
    get<HTMLButtonElement>("[data-start]").disabled = value;
    get<HTMLTextAreaElement>("[data-instruction]").disabled = value;
    get<HTMLButtonElement>("[data-send]").disabled = value;
    get<HTMLTextAreaElement>("[data-revision]").readOnly = value;
    get<HTMLButtonElement>("[data-clear]").disabled = value;
    get<HTMLButtonElement>("[data-apply]").disabled = value || !get<HTMLTextAreaElement>("[data-revision]").value.trim();
    get<HTMLButtonElement>("[data-close]").textContent = value ? t("취소하고 닫기") : t("닫기");
    dialog.setAttribute("aria-busy", String(value));
  }
  function close() {
    generation++;
    window.clearTimeout(timer);
    if (runId && busy) void api.research.cancelMaterialRefinement(runId).catch(() => {});
    busy = false; runId = null;
    dialog.close();
  }
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => { if (opener?.isConnected) opener.focus(); });
  dialog.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.code === "Enter" && !busy) { event.preventDefault(); void start("chat"); }
    if ((event.metaKey || event.ctrlKey) && event.code === "KeyS") { event.preventDefault(); event.stopPropagation(); }
  });
  dialog.addEventListener("click", event => {
    const target = event.target as Element;
    if (target.closest("[data-close]")) close();
    if (target.closest("[data-start]")) void start("refine");
    if (target.closest("[data-send]")) void start("chat");
    if (target.closest("[data-clear]") && !busy) { conversation = []; renderConversation(); }
    if (target.closest("[data-apply]") && !busy) {
      const text = get<HTMLTextAreaElement>("[data-revision]").value;
      if (!text.trim()) return;
      if (apply(text)) close();
      else get<HTMLElement>("[data-status]").textContent = t("편집 중인 해제가 바뀌었습니다. 닫은 뒤 현재 내용으로 다시 실행하세요.");
    }
  });
  dialog.addEventListener("input", event => {
    if ((event.target as Element).matches("[data-revision]")) setBusy(busy);
  });
  function renderConversation() {
    const list = get<HTMLElement>("[data-conversation]");
    list.replaceChildren();
    for (const message of conversation) {
      const article = document.createElement("article");
      const label = document.createElement("b"); label.textContent = message.role === "user" ? t("나") : "AI";
      const body = document.createElement("p"); body.textContent = message.content;
      article.append(label, body); list.append(article);
    }
    list.scrollTop = list.scrollHeight;
  }
  async function start(mode: "chat" | "refine") {
    if (busy) return;
    const instruction = get<HTMLTextAreaElement>("[data-instruction]").value.trim();
    if (mode === "chat" && !instruction) { get<HTMLTextAreaElement>("[data-instruction]").focus(); return; }
    if (mode === "refine" && !input.contentMd.trim() && !get<HTMLTextAreaElement>("[data-revision]").value.trim()) { get<HTMLElement>("[data-status]").textContent = t("먼저 내용을 입력하거나 AI에게 초안 작성을 요청하세요."); return; }
    const history = [...conversation];
    const draftMd = get<HTMLTextAreaElement>("[data-revision]").value || input.contentMd;
    conversation.push({ role: "user", content: instruction || t("내용과 출처를 보존하며 문장과 구성을 다듬어 주세요.") });
    renderConversation();
    const token = ++generation;
    get<HTMLElement>("[data-status]").textContent = t("AI가 답변을 준비하고 있습니다…");
    setBusy(true);
    try {
      const result = await api.research.startMaterialRefinement({ ...input, mode, instruction, conversation: history, draftMd });
      if (token !== generation || !dialog.open) {
        if (result.ok) void api.research.cancelMaterialRefinement(result.data.id).catch(() => {});
        return;
      }
      if (!result.ok) throw new Error(t(result.error.message));
      runId = result.data.id;
      const poll = async () => {
        try {
          const response = await api.research.getMaterialRefinement(runId!);
          if (token !== generation || !dialog.open) return;
          if (!response.ok) throw new Error(t(response.error.message));
          const run = response.data;
          if (run.state === "running") { timer = window.setTimeout(() => void poll(), 700); return; }
          setBusy(false);
          if (run.state === "completed" && run.result) {
            conversation.push({ role: "assistant", content: run.result.notes });
            renderConversation();
            get<HTMLTextAreaElement>("[data-instruction]").value = "";
            if (run.result.contentMd.trim()) get<HTMLTextAreaElement>("[data-revision]").value = run.result.contentMd;
            get<HTMLElement>("[data-result]").hidden = !get<HTMLTextAreaElement>("[data-revision]").value.trim();
            get<HTMLElement>("[data-status]").textContent = run.result.contentMd ? t("수정안을 검토하세요. 편집란에 적용한 뒤 저장하면 반영됩니다.") : t("답변을 받았습니다. 이어서 질문할 수 있습니다.");
            setBusy(false);
          } else get<HTMLElement>("[data-status]").textContent = run.error ? t(run.error.message) : t("취소됨");
        } catch (error) {
          if (token !== generation) return;
          if (runId) void api.research.cancelMaterialRefinement(runId).catch(() => {});
          setBusy(false);
          get<HTMLElement>("[data-status]").textContent = error instanceof Error ? error.message : t("AI 수정안을 불러오지 못했습니다.");
        }
      };
      void poll();
    } catch (error) {
      if (token !== generation) return;
      setBusy(false);
      get<HTMLElement>("[data-status]").textContent = error instanceof Error ? error.message : t("AI 수정안을 불러오지 못했습니다.");
    }
  }
  return {
    isOpen: () => dialog.open,
    open(value: Omit<MaterialRefinementInput, "instruction">, applyRevision: (text: string) => boolean) {
      if (dialog.open) return;
      input = { ...value, instruction: "" }; apply = applyRevision; conversation = [];
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.innerHTML = ui`<header><h2>문맥 노트 AI</h2><p>기존 내용과 출처를 보존하며 문장과 구성을 정리합니다. 별도 요청이 없으면 기존 언어를 유지합니다.</p></header>
        <div class="material-refinement-body"><section data-conversation class="material-conversation" role="log" aria-label="노트에 관한 대화" aria-live="polite"></section><label>질문 또는 다듬기 요청<textarea class="textarea" data-instruction maxlength="4000" rows="2" placeholder="예: 이 해제에서 근거가 부족한 부분은? / 중복을 줄여서 다듬어 줘"></textarea></label>
        <div class="material-refinement-columns"><label>현재 해제<textarea class="textarea" data-original readonly rows="12"></textarea></label><section data-result hidden><label>AI 수정안<textarea class="textarea" data-revision maxlength="200000" rows="12"></textarea></label></section></div>
        <p data-status role="status"></p><p class="muted">대화는 이 창을 닫으면 지워집니다. 필요한 수정안은 편집란에 적용해 저장하세요.</p></div><footer><button class="btn" type="button" data-close>닫기</button><button class="btn" type="button" data-clear>새 대화</button><span class="sp"></span><button class="btn" type="button" data-send>보내기</button><button class="btn" type="button" data-start>AI로 다듬기</button><button class="btn btn-primary" type="button" data-apply disabled>편집란에 적용</button></footer>`;
      get<HTMLTextAreaElement>("[data-original]").value = value.contentMd;
      setBusy(false);
      dialog.showModal();
      get<HTMLTextAreaElement>("[data-instruction]").focus();
    },
  };
}
