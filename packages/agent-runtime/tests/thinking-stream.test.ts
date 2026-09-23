import { describe, expect, it } from "vitest";
import { createClaudeJsonlParser, createCodexJsonlParser } from "../src/index";

describe("provider-visible thinking stream", () => {
  it("publishes Codex's unseen suffix before completion and separates items", () => {
    const events: any[] = [];
    const parser = createCodexJsonlParser(e => events.push(e));
    const feed = (type: string, id: string, text: string) => parser.feed(JSON.stringify({ type, item: { id, type: "reasoning", text } }) + "\n");
    feed("item.started", "r1", "문맥");
    expect(events.at(-1)).toEqual({ type: "thinking_delta", text: "문맥" });
    feed("item.updated", "r1", "문맥 검토");
    feed("item.completed", "r1", "문맥 검토");
    feed("item.completed", "r2", "용어 확인");
    expect(events.filter(e => e.type === "thinking_delta").map(e => e.text).join("")).toBe("문맥 검토\n\n용어 확인");
    expect(parser.snapshot().outputText).toBe("");
  });

  it("publishes Claude deltas immediately and deduplicates full assistant snapshots", () => {
    const events: any[] = [];
    const parser = createClaudeJsonlParser(e => events.push(e));
    const feed = (v: object) => parser.feed(JSON.stringify(v) + "\n");
    const stream = (event: object) => feed({ type: "stream_event", event });
    stream({ type: "message_start", message: { id: "m1" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "원문 " } });
    expect(events.at(-1)).toEqual({ type: "thinking_delta", text: "원문 " });
    stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "확인" } });
    stream({ type: "content_block_stop", index: 0 });
    const message = { type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "원문 확인" }, { type: "text", text: "답변" }] } };
    feed(message); feed(message);
    feed({ type: "assistant", message: { id: "m2", content: [{ type: "thinking", thinking: "다음 검토" }] } });
    feed({ type: "result", result: "최종 답변", is_error: false });
    parser.finish();
    expect(events.filter(e => e.type === "thinking_delta").map(e => e.text).join("")).toBe("원문 확인\n\n다음 검토");
    expect(parser.snapshot().outputText).toBe("최종 답변");
  });

  it("does not invent text from empty or signature-only thinking", () => {
    const events: any[] = [];
    const parser = createClaudeJsonlParser(e => events.push(e));
    parser.feed(JSON.stringify({ type: "assistant", message: { id: "empty", content: [{ type: "thinking", thinking: "", signature: "opaque" }] } }) + "\n");
    expect(events.filter(e => e.type === "thinking_delta").map(e => e.text).join("")).toBe("");
  });
});

describe("conversational text stream", () => {
  it("forwards each Codex message before turn completion, deduplicates replay, and retains only the final result", () => {
    const events: any[] = [];
    const parser = createCodexJsonlParser(e => events.push(e), undefined, [], { streamText: true });
    const feed = (value: object) => parser.feed(JSON.stringify(value) + "\n");
    const progress = { type: "item.completed", item: { id: "p", type: "agent_message", text: "출전을 찾았습니다." } };
    feed(progress);
    expect(events).toEqual([{ type: "text_delta", text: "출전을 찾았습니다." }]);
    feed(progress);
    feed({ type: "item.started", item: { id: "tool", type: "command_execution" } });
    feed({ type: "item.completed", item: { id: "f", type: "agent_message", text: "최종 답변" } });
    feed({ type: "turn.completed" }); parser.finish();
    expect(events.filter(e => e.type === "text_delta").map(e => e.text).join("")).toBe("출전을 찾았습니다.\n\n최종 답변");
    expect(parser.snapshot().outputText).toBe("최종 답변");
  });

  it("streams Claude fragments immediately without repeating assistant snapshots or the result", () => {
    const events: any[] = [];
    const parser = createClaudeJsonlParser(e => events.push(e), undefined, [], { streamText: true });
    const feed = (value: object) => parser.feed(JSON.stringify(value) + "\n");
    const stream = (event: object) => feed({ type: "stream_event", event });
    stream({ type: "message_start", message: { id: "p" } });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "확인 " } });
    expect(events.at(-1)).toEqual({ type: "text_delta", text: "확인 " });
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "중" } });
    feed({ type: "assistant", message: { id: "p", content: [{ type: "text", text: "확인 중" }] } });
    const final = { type: "assistant", message: { id: "f", content: [{ type: "text", text: "답변" }] } };
    feed(final); feed(final);
    feed({ type: "result", result: "답변" }); parser.finish();
    expect(events.filter(e => e.type === "text_delta").map(e => e.text).join("")).toBe("확인 중\n답변");
    expect(parser.snapshot().outputText).toBe("답변");
  });
});
