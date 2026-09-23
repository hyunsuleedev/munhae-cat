import { chatMarkdown } from "./chat-ui";
import { esc } from "./shared";
import { t } from "./i18n";
import type { ChatActivityBlock } from "../../shared/munhae-api";
import "../styles/thinking.css";

const paths: Record<string, string> = {
  thinking: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  read: '<path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4zm9-9 4 4"/>',
  tool: '<path d="m8 4 4 4-4 4M15 13l4 4-4 4M3 8h9m0 9h7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
};
const icon = (name: string) => `<svg class="chat-activity-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.tool}</svg>`;
const spinner = '<span class="chat-activity-spinner" aria-hidden="true"></span>';

/** Only provider-visible text belongs in this disclosure. */
export function thinkingMarkup(text: string | undefined, key: string, open = false, running = false): string {
  if (!text?.trim()) return "";
  return `<details class="chat-thinking" data-thinking-key="${esc(key)}"${open ? " open" : ""}><summary><span class="chat-activity-symbol thinking">${running ? spinner : icon("thinking")}</span><span>${esc(t("생각 과정"))}</span><span class="chat-activity-state">${esc(t(running ? "생각 중" : "생각 완료"))}</span>${icon("chevron")}</summary><div class="chat-thinking-text">${esc(text)}</div></details>`;
}

function toolPresentation(name: string): [string, string] {
  if (/search|grep|glob/i.test(name)) return ["search", "검색"];
  if (/read|open|fetch/i.test(name)) return ["read", "자료 읽기"];
  if (/command|bash|shell|exec/i.test(name)) return ["terminal", "명령 실행"];
  if (/write|edit|file_change|patch/i.test(name)) return ["edit", "파일 수정"];
  return ["tool", "도구 실행"];
}

export type ActivityOptions = {
  /** Use an existing disclosure supplied by the surrounding UI. */
  grouped?: boolean;
  state?: "running" | "completed" | "failed" | "canceled";
  startedAt?: string;
  completedAt?: string | null;
  overrides?: ReadonlyMap<string, boolean>;
};

/** Activity is secondary to prose; calls keep their identity as state changes. */
export function chatActivityMarkup(blocks: ChatActivityBlock[] | undefined, key: string, openKeys: Set<string | undefined>, finalText?: string, options: ActivityOptions = {}): string {
  const running = options.state === "running";
  const visible = (blocks ?? []).map(block => ({ ...block }));
  const last = visible.at(-1);
  if (finalText && last?.kind === "text" && last.text.trimEnd().endsWith(finalText.trim())) {
    last.text = last.text.trimEnd().slice(0, -finalText.trim().length).trimEnd();
  }
  const isOpen = (id: string, fallback: boolean) => options.overrides?.get(id) ?? (openKeys.has(id) || fallback);
  const activity = visible.map((block, index) => {
    const blockKey = `${key}:${index}`;
    if (block.kind === "thinking") return thinkingMarkup(block.text, blockKey, isOpen(blockKey, false), running && index === visible.length - 1);
    if (block.kind !== "tool") return "";
    const [symbol, title] = toolPresentation(block.name ?? "tool");
    const active = block.state === "started" && running;
    const failed = block.state === "failed";
    const interrupted = block.state === "started" && !running;
    const label = failed ? "실패" : active ? "실행 중" : interrupted ? "중단됨" : "완료";
    return `<div class="chat-tool-activity" data-tool-id="${esc(block.id ?? blockKey)}" data-state="${active ? "running" : failed ? "failed" : interrupted ? "stopped" : "completed"}"><span class="chat-activity-symbol">${icon(symbol)}</span><span class="chat-tool-title">${esc(t(title))}<span class="chat-tool-name">${esc(block.name ?? block.text)}</span></span><span class="chat-tool-status">${active ? spinner : failed ? icon("error") : interrupted ? "" : icon("check")}${esc(t(label))}</span></div>`;
  }).join("");
  const prose = visible.filter(block => block.kind === "text" && block.text.trim()).map(block => `<div class="msg-body chat-stream-text chat-markdown">${chatMarkdown(block.text)}</div>`).join("");
  if (!activity) return prose;
  if (options.grouped === false) return activity + prose;
  const groupKey = `${key}:activity`;
  const seconds = options.startedAt && options.completedAt ? Math.max(0, Math.round((Date.parse(options.completedAt) - Date.parse(options.startedAt)) / 1000)) : null;
  const duration = seconds !== null && Number.isFinite(seconds) ? ` · ${seconds}${esc(t("초"))}` : "";
  const stateLabel = running ? "진행 중" : options.state === "failed" ? "실패" : options.state === "canceled" ? "취소됨" : "완료";
  return `<details class="chat-activity" data-thinking-key="${esc(groupKey)}"${isOpen(groupKey, running) ? " open" : ""}><summary>${icon("chevron")}<span>${esc(t("작업 과정"))}</span><span class="chat-activity-state">${esc(t(stateLabel))}${duration}</span></summary><div class="chat-activity-timeline">${activity}</div></details>${prose}`;
}
