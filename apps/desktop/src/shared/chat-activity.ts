import type { AgentRunEvent } from "@munhae/agent-runtime";
import type { ChatActivityBlock } from "./munhae-api";

export function appendChatActivity(blocks: ChatActivityBlock[], event: AgentRunEvent, agentId: string): void {
  const kind = event.type === "text_delta" ? "text" : event.type === "thinking_delta" && (agentId === "claude" || agentId === "codex") ? "thinking" : event.type === "tool_call" ? "tool" : null;
  const text = event.type === "text_delta" || event.type === "thinking_delta" ? event.text : event.type === "tool_call" ? `${event.name} · ${event.state === "started" ? "실행 중" : event.state === "failed" ? "실패" : "완료"}` : "";
  if (kind && text) {

    const last = blocks.at(-1);
    const existing = event.type === "tool_call" && event.id ? blocks.find(block => block.kind === "tool" && block.id === event.id) : undefined;
    if (event.type === "tool_call" && existing) {
      // Terminal events may be replayed; never regress a completed call.
      if (event.state !== "started" || existing.state === "started") {
        existing.state = event.state;
        existing.text = text;
      }
    } else if (event.type === "tool_call") blocks.push({ kind: "tool", text, name: event.name, state: event.state, ...(event.id ? { id: event.id } : {}) });
    else if (kind !== "tool" && last?.kind === kind) last.text = (last.text + text).slice(-200_000);
    else blocks.push({ kind, text: text.slice(-200_000) });
    if (blocks.length > 200) blocks.shift();
  }
}
