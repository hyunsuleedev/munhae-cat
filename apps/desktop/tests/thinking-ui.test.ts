import { expect, it } from "vitest";
import { thinkingMarkup } from "../src/renderer/scripts/thinking-ui";

it("hides absent thinking and escapes provider content in a separate collapsible block", () => {
  expect(thinkingMarkup(undefined, "run")).toBe("");
  expect(thinkingMarkup("  ", "run")).toBe("");
  const markup = thinkingMarkup('<script>alert(1)</script>\n검토', 'run"id', true);
  expect(markup).toContain("<details");
  expect(markup).toContain(" open>");
  expect(markup).toContain("생각 과정");
  expect(markup).toContain("&lt;script&gt;");
  expect(markup).not.toContain("<script>");
  expect(markup).toContain('run&quot;id');
});

it("groups activity separately from prose, escapes text, and avoids a duplicate final answer", async () => {
  const { chatActivityMarkup } = await import("../src/renderer/scripts/thinking-ui");
  const markup = chatActivityMarkup([
    { kind: "text", text: "<진행>" },
    { kind: "tool", text: "검색 · 완료" },
    { kind: "thinking", text: "검토" },
    { kind: "text", text: "최종 답변" },
  ], "run", new Set(["run:2"]), "최종 답변");
  expect(markup.indexOf("&lt;진행&gt;")).toBeGreaterThan(markup.indexOf("검토"));
  expect(markup.indexOf("검색")).toBeLessThan(markup.indexOf("검토"));
  expect(markup).toContain('data-thinking-key="run:2" open');
  expect(markup).not.toContain("최종 답변");
});


it("defaults activity open while running and closed after completion, while respecting explicit choices", async () => {
  const { chatActivityMarkup } = await import("../src/renderer/scripts/thinking-ui");
  const blocks = [{ kind: "thinking" as const, text: "검토 중" }];
  const render = (state: "running" | "completed", override?: boolean) => chatActivityMarkup(blocks, "run", new Set(), undefined, { state, overrides: override === undefined ? undefined : new Map([["run:activity", override]]) });
  expect(render("running")).toContain('data-thinking-key="run:activity" open');
  expect(render("completed")).not.toContain('data-thinking-key="run:activity" open');
  expect(render("completed", true)).toContain('data-thinking-key="run:activity" open');
  expect(render("running", false)).not.toContain('data-thinking-key="run:activity" open');
  expect(render("running")).toContain("생각 중");
  expect(render("completed")).toContain("생각 완료");
});

it("marks unfinished calls as stopped on cancellation instead of falsely completed", async () => {
  const { chatActivityMarkup } = await import("../src/renderer/scripts/thinking-ui");
  const markup = chatActivityMarkup([{ kind: "tool", id: "a", name: "web_search", state: "started", text: "" }], "run", new Set(), undefined, { state: "canceled" });
  expect(markup).toContain('data-state="stopped"');
  expect(markup).toContain("중단됨");
  expect(markup).toContain("검색");
});

it("uses the translation dialog's disclosure without nesting a second activity group", async () => {
  const { chatActivityMarkup } = await import("../src/renderer/scripts/thinking-ui");
  const markup = chatActivityMarkup([{ kind: "thinking", text: "<검토>" }], "run", new Set(), undefined, { grouped: false, state: "running" });
  expect(markup).toContain('class="chat-thinking"');
  expect(markup).toContain("&lt;검토&gt;");
  expect(markup).not.toContain('class="chat-activity"');
});

it("shows app rejection details and a subsequent successful submission instead of duplicate shell failures", async () => {
  const { chatActivityMarkup } = await import("../src/renderer/scripts/thinking-ui");
  const markup = chatActivityMarkup([
    { kind: "tool", id: "shell1", name: "command_execution", state: "failed", text: "" },
    { kind: "tool", appTool: true, parentToolId: "shell1", id: "app1", name: "submit-alignment", state: "failed", text: "", detail: "원문 중복 <T7>" },
    { kind: "tool", appTool: true, id: "app2", name: "submit-alignment", state: "completed", text: "", detail: "연결을 저장했습니다." },
  ], "run", new Set());
  expect(markup).toContain("원문 연결 제출");
  expect(markup).toContain("요청 거부");
  expect(markup).toContain("원문 중복 &lt;T7&gt;");
  expect(markup).toContain("이후 요청 성공");
  expect(markup).not.toContain("command_execution");
});

it("keeps unresolved app rejections and unexplained shell failures visible", async () => {
  const { chatActivityMarkup } = await import("../src/renderer/scripts/thinking-ui");
  const markup = chatActivityMarkup([
    { kind: "tool", id: "shell1", name: "command_execution", state: "failed", text: "" },
    { kind: "tool", appTool: true, parentToolId: "shell1", name: "check-alignment", state: "completed", text: "", detail: "검사 완료" },
    { kind: "tool", appTool: true, name: "submit-alignment", state: "failed", text: "", detail: "연결 해제 사유 필요" },
    { kind: "tool", appTool: true, name: "check-alignment", state: "completed", text: "" },
  ], "run", new Set());
  expect(markup).toContain("command_execution");
  expect(markup).toContain("연결 해제 사유 필요");
  expect(markup).not.toContain("이후 요청 성공");
});
