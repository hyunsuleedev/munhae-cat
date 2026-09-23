import { chatMessageMarkup, configureChatSurface, isChatSubmit } from "./chat-ui";
import { thinkingMarkup, chatActivityMarkup } from "./thinking-ui";
import type { MunhaeApi } from "../../shared/munhae-api";
import { t, ui } from "./i18n";
export type ContextChatNote = { key: string; scopeId: string; title: string; contentMd: string; apply(original: string, text: string): boolean };
type Message = { role: "user" | "assistant"; content: string; thinking?: string; activity?: import("../../shared/munhae-api").ChatActivityBlock[] };
type Thread = { messages: Message[]; proposal?: { original: string; text: string }; question: string };
export function configureContextChat(api: MunhaeApi, projectId: string, notes: () => ContextChatNote[]) {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id)! as T;
  const threads = new Map<string, Thread>();
  let selected = "";
  let busy = false;
  let thinkingText = "";
  let activity: import("../../shared/munhae-api").ChatActivityBlock[] = [];
  const disclosureOverrides = new Map<string, boolean>();
  el("contextChatList").addEventListener("click", event => {
    const details = (event.target as Element).closest("summary")?.parentElement as HTMLDetailsElement | undefined;
    if (details?.dataset.thinkingKey) disclosureOverrides.set(details.dataset.thinkingKey, !details.open);
  });
  let cancelRequested = false;
  const aliases = new Map<string, string>();
  let id: string | null = null;
  let config = { agentId: "" as string, model: "" };
  const storageKey = (key: string) => `munhae:context-chat:v1:${projectId}:${aliases.get(key) ?? key}`;
  function thread(key = selected): Thread {
    if (!threads.has(key)) {
      let messages: Message[] = [];
      let proposal: Thread["proposal"];
      try {
        const stored = JSON.parse(localStorage.getItem(storageKey(key)) ?? "[]");
        const history = Array.isArray(stored) ? stored : stored?.messages;
        if (stored?.proposal && typeof stored.proposal.original === "string" && stored.proposal.original.length <= 200000 && typeof stored.proposal.text === "string" && stored.proposal.text.length <= 200000) proposal = stored.proposal;
        if (Array.isArray(history)) messages = history.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && m.content.length <= 20000).slice(-40);
      } catch { /* An unavailable or invalid local history must not block chat. */ }
      threads.set(key, { messages, proposal, question: "" });
    }
    return threads.get(key)!;
  }
  function persist(key: string) {
    // Draft material is never saved by chat; only the conversation is retained here.
    try { localStorage.setItem(storageKey(key), JSON.stringify({ messages: thread(key).messages.slice(-40).map(({ role, content }) => ({ role, content })), proposal: thread(key).proposal })); }
    catch { el<HTMLElement>("contextChatStatus").textContent = t("대화 기록을 저장하지 못했습니다."); }
  }
  let failedRequest: { question: string; mode: "chat" | "refine"; error: string } | null = null;
  const surface = configureChatSurface(el("contextChatList"), el<HTMLTextAreaElement>("contextChatInput"), {
    key: () => `context:${projectId}:${aliases.get(selected) ?? selected}`,
    messages: () => thread().messages.map(message => ({ role: message.role, text: message.content })),
    changed: () => { el<HTMLButtonElement>("contextChatSend").disabled = busy || !notes().length || !el<HTMLTextAreaElement>("contextChatInput").value.trim(); },
    retry: () => { if (failedRequest && !busy) { const request = failedRequest; surface.setDraft(request.question); void send(request.mode); } },
  });
  function render() {
    const state = thread();
    const list = el<HTMLElement>("contextChatList");
    surface.sync();
    const restoreScroll = surface.captureScroll();
    const thinkingOpenKeys = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>("details.chat-thinking[open]")).map(el => el.dataset.thinkingKey));
    const thinkingOpen = thinkingOpenKeys.has("context");
    list.replaceChildren();
    if (!state.messages.length) {
      const empty = document.createElement("p"); empty.className = "context-chat-empty";
      empty.textContent = t("이 문맥에 대해 자유롭게 질문하세요. 대화만으로 노트가 바뀌지는 않습니다."); list.append(empty);
    }
    for (const [index, message] of state.messages.entries()) {
      const activityMarkup = message.activity?.length ? chatActivityMarkup(message.activity, String(index), new Set(), undefined, { state: "completed", overrides: disclosureOverrides }) : thinkingMarkup(message.thinking, String(index), thinkingOpenKeys.has(String(index)));
      list.insertAdjacentHTML("beforeend", chatMessageMarkup({ role: message.role, text: message.content }, index, activityMarkup));
    }
    if (activity.length) list.insertAdjacentHTML("beforeend", chatActivityMarkup(activity, "context", new Set(), undefined, { state: busy ? "running" : "canceled", overrides: disclosureOverrides }));
    else if (thinkingText) list.insertAdjacentHTML("beforeend", thinkingMarkup(thinkingText, "context", thinkingOpen, busy));
    if (busy) { const status = document.createElement("p"); status.className = "context-chat-empty"; status.textContent = t("AI가 답변을 준비하고 있습니다…"); list.append(status); }
    if (failedRequest && !busy) {
      const error = document.createElement("div"); error.className = "chat-error"; error.setAttribute("role", "alert");
      const text = document.createElement("p"); text.textContent = failedRequest.error;
      const retry = document.createElement("button"); retry.type = "button"; retry.className = "btn btn-sm"; retry.dataset.chatAction = "retry"; retry.textContent = t("다시 시도");
      error.append(text, retry); list.append(error);
    }
    restoreScroll(); surface.afterRender();
    el<HTMLSelectElement>("contextChatNote").disabled = busy;
    el<HTMLTextAreaElement>("contextChatInput").disabled = false;
    el<HTMLButtonElement>("contextChatSend").disabled = busy || !notes().length || !el<HTMLTextAreaElement>("contextChatInput").value.trim();
    el<HTMLButtonElement>("contextChatRefine").disabled = busy || !notes().length;
    el<HTMLButtonElement>("contextChatClear").disabled = busy;
    el<HTMLButtonElement>("contextChatCancel").hidden = !busy;
    el<HTMLButtonElement>("contextChatReview").hidden = !state.proposal;
    el<HTMLButtonElement>("contextChatReview").disabled = busy;
  }
  function refresh() {
    const available = notes();
    const select = el<HTMLSelectElement>("contextChatNote");
    if (!available.some(n => n.key === selected)) selected = available[0]?.key ?? "";
    select.replaceChildren(...available.map(note => { const option = document.createElement("option"); option.value = note.key; option.textContent = note.title || t("새 문맥"); return option; }));
    select.value = selected;
    render();
  }
  const review = document.createElement("dialog"); review.className = "context-chat-review";
  review.setAttribute("aria-label", t("AI 수정안 검토")); document.body.append(review);
  review.addEventListener("keydown", event => { if ((event.metaKey || event.ctrlKey) && event.code === "KeyS") { event.preventDefault(); event.stopPropagation(); } });
  function showProposal() {
    const state = thread(); const proposal = state.proposal; const key = selected;
    if (!proposal) return;
    review.innerHTML = ui`<header><h2>AI 수정안 검토</h2></header><div class="context-chat-comparison"><label>현재 해제<textarea class="textarea" data-original readonly></textarea></label><label>AI 수정안<textarea class="textarea" data-proposal maxlength="200000"></textarea></label></div><p data-status role="status"></p><footer><button class="btn" data-close>닫기</button><button class="btn btn-primary" data-apply>편집란에 적용</button></footer>`;
    review.querySelector<HTMLTextAreaElement>("[data-original]")!.value = proposal.original;
    review.querySelector<HTMLTextAreaElement>("[data-proposal]")!.value = proposal.text;
    review.querySelector("[data-close]")!.addEventListener("click", () => review.close());
    review.querySelector("[data-apply]")!.addEventListener("click", () => {
      const text = review.querySelector<HTMLTextAreaElement>("[data-proposal]")!.value;
      if (!text.trim()) return;
      const note = notes().find(n => n.key === key);
      if (!note?.apply(proposal.original, text)) {
        review.querySelector<HTMLElement>("[data-status]")!.textContent = t("편집 중인 해제가 바뀌었습니다. 닫은 뒤 현재 내용으로 다시 실행하세요."); return;
      }
      delete state.proposal; persist(key); review.close(); render();
      el<HTMLElement>("contextChatStatus").textContent = t("편집란에 적용했습니다. 노트를 저장하면 반영됩니다.");
    });

    review.showModal();
  }
  async function send(mode: "chat" | "refine") {
    if (busy) return;
    const note = notes().find(n => n.key === selected); if (!note) return;
    const question = el<HTMLTextAreaElement>("contextChatInput").value.trim();
    if (mode === "chat" && !question) { el<HTMLTextAreaElement>("contextChatInput").focus(); return; }
    const key = selected; const state = thread(key); const history = state.messages.slice(-38).map(({ role, content }) => ({ role, content }));
    thinkingText = ""; activity = [];
    for (const key of [...disclosureOverrides.keys()]) if (key.startsWith("context:")) disclosureOverrides.delete(key);
    failedRequest = null;
    busy = true; id = null; cancelRequested = false;
    state.messages.push({ role: "user", content: question || t("내용과 출처를 보존하며 문장과 구성을 다듬어 주세요.") });
    state.question = ""; surface.setDraft("");
    el<HTMLElement>("contextChatStatus").textContent = ""; render(); surface.bottom();
    try {
      const response = await api.research.startMaterialRefinement({ scopeId: note.scopeId, title: note.title, contentMd: note.contentMd, instruction: question, mode, conversation: history, draftMd: state.proposal?.original === note.contentMd ? state.proposal.text : undefined });
      if (!response.ok) throw new Error(t(response.error.message));
      id = response.data.id;
      if (cancelRequested) await api.research.cancelMaterialRefinement(id);
      for (;;) {
        const result = await api.research.getMaterialRefinement(id);
        if (!result.ok) throw new Error(t(result.error.message));
        const nextActivity = result.data.activity ?? [];
        const nextThinking = result.data.thinkingText ?? "";
        if (JSON.stringify(activity) !== JSON.stringify(nextActivity) || thinkingText !== nextThinking) {
          activity = nextActivity; thinkingText = nextThinking; render();
        }
        if (result.data.state !== "running") {
          if (result.data.state === "completed" && result.data.result) {
            for (const [key, open] of [...disclosureOverrides]) if (key.startsWith("context:")) disclosureOverrides.set(key.replace("context:", `${state.messages.length}:`), open);
            state.messages.push({ role: "assistant", content: result.data.result.notes, thinking: thinkingText, activity });
            thinkingText = ""; activity = [];
            if (result.data.result.contentMd.trim()) state.proposal = { original: note.contentMd, text: result.data.result.contentMd };
            persist(key);
          } else {
            const error = result.data.error ? t(result.data.error.message) : t("취소됨");
            if (result.data.state === "failed") failedRequest = { question, mode, error };
            else el<HTMLElement>("contextChatStatus").textContent = error;
          }
          break;
        }
        await new Promise(resolve => window.setTimeout(resolve, 700));
      }
    } catch (error) {
      if (id) void api.research.cancelMaterialRefinement(id).catch(() => {});
      failedRequest = { question, mode, error: error instanceof Error ? error.message : t("AI 수정안을 불러오지 못했습니다.") };
      if (!el<HTMLTextAreaElement>("contextChatInput").value.trim()) surface.setDraft(question);
    } finally { busy = false; id = null; render(); }
  }
  el<HTMLSelectElement>("contextChatNote").addEventListener("change", event => {
    thread().question = el<HTMLTextAreaElement>("contextChatInput").value;
    thinkingText = ""; activity = [];
    selected = (event.target as HTMLSelectElement).value;
    failedRequest = null; el<HTMLElement>("contextChatStatus").textContent = ""; render(); surface.bottom();
  });
  el<HTMLFormElement>("contextChatForm").addEventListener("submit", event => { event.preventDefault(); void send("chat"); });
  el<HTMLTextAreaElement>("contextChatInput").addEventListener("keydown", event => {
    if (isChatSubmit(event)) { event.preventDefault(); void send("chat"); }
  });
  el<HTMLElement>("contextChatRefine").addEventListener("click", () => void send("refine"));
  el<HTMLElement>("contextChatCancel").addEventListener("click", () => { cancelRequested = true; if (id) void api.research.cancelMaterialRefinement(id).catch(() => {}); });
  el<HTMLElement>("contextChatReview").addEventListener("click", showProposal);
  el<HTMLElement>("contextChatClear").addEventListener("click", () => {
    if (busy || !window.confirm(t("이 노트의 대화 기록을 지우시겠습니까?"))) return;
    thinkingText = ""; activity = [];
    failedRequest = null;
    thread().messages = []; delete thread().proposal; persist(selected); render();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-context-tab]")) button.addEventListener("click", () => {
    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-context-tab]")) tab.setAttribute("aria-selected", String(tab === button));
    el<HTMLElement>("contextChatPanel").hidden = button.dataset.contextTab !== "chat";
    el<HTMLElement>("contextReferencesPanel").hidden = button.dataset.contextTab !== "references";
  });
  void api.app.getConfig().then(value => { config = { agentId: value.agentId, model: value.agentModels[value.agentId].model }; el<HTMLElement>("contextChatModel").textContent = `${config.agentId} · ${config.model}`; }).catch(() => {});
  return { refresh, rekey(previous: string, next: string) {
    if (previous === next) return;
    const oldStorage = storageKey(previous);
    const state = thread(previous); aliases.set(previous, next); threads.set(next, state); persist(next);
    try { localStorage.removeItem(oldStorage); } catch { /* New history remains available in memory. */ }
    if (selected === previous) selected = next;
    refresh();
  }, isBusy: () => busy || review.open };
}
