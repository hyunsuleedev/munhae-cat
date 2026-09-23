import MarkdownIt from "markdown-it";
import { esc, requireApi, notify } from "./shared";
import { t } from "./i18n";
import "../styles/chat-ui.css";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });
markdown.validateLink = url => {
  try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; }
};
const defaultLink = markdown.renderer.rules.link_open;
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet("target", "_blank");
  tokens[index]!.attrSet("rel", "noopener noreferrer");
  return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
};
markdown.renderer.rules.image = (tokens, index) => esc(tokens[index]!.content); // Chat does not load remote tracking images.
export function chatMarkdown(text: string): string { return markdown.render(text); }
const actionIcons = {
  copy: '<rect x="8" y="8" width="11" height="12" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z"/>',
  done: '<path d="m5 12 4 4L19 6"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
};
const actionIcon = (name: keyof typeof actionIcons) => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${actionIcons[name]}</svg>`;
function actionButton(action: "copy" | "edit", index: number): string {
  const label = esc(t(action === "copy" ? "복사" : "수정해서 다시 묻기"));
  return `<button type="button" data-chat-action="${action}" data-message-index="${index}" aria-label="${label}" data-tooltip="${label}">${actionIcon(action)}</button>`;
}
export type ChatMessage = { role: "user" | "assistant"; text: string; time?: string; meta?: string };
export function chatMessageMarkup(message: ChatMessage, index: number, activity = ""): string {
  const user = message.role === "user";
  const action = user ? actionButton("edit", index) : "";
  const details = [message.time, message.meta].filter(Boolean).join(" · ");
  return `<article class="msg msg-${user ? "user" : "ai"}">${activity}<div class="msg-body${user ? "" : " chat-markdown"}">${user ? esc(message.text) : chatMarkdown(message.text)}</div><footer class="chat-message-actions"${details ? ` title="${esc(details)}"` : ""}>${actionButton("copy", index)}${action}</footer></article>`;
}
export function loadChatDraft(key: string): string {
  try { return localStorage.getItem(`munhae:chat-draft:${key}`) ?? ""; } catch { return ""; }
}
export function saveChatDraft(key: string, value: string): void {
  try { if (value) localStorage.setItem(`munhae:chat-draft:${key}`, value); else localStorage.removeItem(`munhae:chat-draft:${key}`); } catch { /* Storage failure must not block composition. */ }
}
export function isChatSubmit(event: KeyboardEvent): boolean {
  return !event.isComposing && event.keyCode !== 229 && (event.metaKey || event.ctrlKey) && event.key === "Enter";
}
export function configureChatSurface(list: HTMLElement, input: HTMLTextAreaElement, options: {
  key(): string;
  messages(): ChatMessage[];
  changed(): void;
  retry?(): void;
}) {
  list.classList.add("chat-surface"); input.closest("form")?.classList.add("chat-composer");
  list.setAttribute("aria-label", t("대화 기록"));
  const jump = document.createElement("button"); jump.type = "button"; jump.className = "chat-jump-latest";
  const jumpOverlay = document.createElement("div"); jumpOverlay.className = "chat-jump-overlay";
  jump.textContent = `${t("최신 답변으로")} ↓`; jump.hidden = true;
  jumpOverlay.append(jump); list.after(jumpOverlay);
  let currentKey = "";
  let pinned = true;
  let savedTop = 0;
  const resize = () => { input.style.height = "auto"; input.style.height = `${Math.min(180, Math.max(56, input.scrollHeight))}px`; };
  const updateJump = () => { jump.hidden = list.scrollHeight - list.scrollTop - list.clientHeight < 64; };
  const bottom = () => { pinned = true; list.scrollTop = list.scrollHeight; savedTop = list.scrollTop; updateJump(); };
  jump.addEventListener("click", bottom);
  list.addEventListener("scroll", () => {
    if (list.clientHeight > 0) {
      pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 64;
      savedTop = list.scrollTop;
    }
    updateJump();
  }, { passive: true });
  list.addEventListener("wheel", event => { if (event.deltaY < 0) { pinned = false; } }, { passive: true });
  input.addEventListener("input", () => { if (currentKey) saveChatDraft(currentKey, input.value); resize(); options.changed(); });
  const setDraft = (value: string) => { input.value = value; if (currentKey) saveChatDraft(currentKey, value); resize(); options.changed(); };
  const copyTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  list.addEventListener("click", async event => {
    const link = (event.target as Element).closest<HTMLAnchorElement>(".chat-markdown a");
    if (link) {
      event.preventDefault();
      try { await requireApi().app.openChatSource(link.href); }
      catch { notify(t("출처 링크를 열지 못했습니다."), t("AI 채팅")); }
      return;
    }
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-chat-action]");
    if (!button) return;
    if (button.dataset.chatAction === "retry") { options.retry?.(); return; }
    const message = options.messages()[Number(button.dataset.messageIndex)];
    if (!message) return;
    if (button.dataset.chatAction === "edit") { setDraft(message.text); input.focus(); return; }
    clearTimeout(copyTimers.get(button));
    let copied = false;
    try { await requireApi().app.copyText(message.text); copied = true; } catch { /* Keep retry available. */ }
    const label = t(copied ? "복사됨" : "복사 실패");
    button.innerHTML = actionIcon(copied ? "done" : "error");
    button.setAttribute("aria-label", label); button.dataset.tooltip = label;
    copyTimers.set(button, setTimeout(() => {
      button.innerHTML = actionIcon("copy");
      button.setAttribute("aria-label", t("복사")); button.dataset.tooltip = t("복사");
    }, 1800));
  });
  return {
    sync() {
      const nextKey = options.key();
      if (nextKey !== currentKey) {
        if (currentKey) saveChatDraft(currentKey, input.value);
        pinned = true; savedTop = 0;
        currentKey = nextKey; input.value = nextKey ? loadChatDraft(nextKey) : ""; resize();
      }
    },
    setDraft, bottom,
    afterRender() { updateJump(); resize(); },
    captureScroll() {
      const follow = pinned;
      const top = savedTop;
      return () => {
        list.scrollTop = follow ? list.scrollHeight : top;
        savedTop = list.scrollTop;
        updateJump();
      };
    },
  };
}
