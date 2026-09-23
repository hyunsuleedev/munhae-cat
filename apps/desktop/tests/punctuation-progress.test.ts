import { describe, expect, it } from "vitest";
import { punctuationProgressState } from "../src/renderer/scripts/punctuation-progress-ui";

describe("punctuation progress", () => {
  it("tracks preparation, generation, validation, and validated completion", () => {
    expect(punctuationProgressState(null, true)).toMatchObject({ step: 0, running: true, completed: false });
    expect(punctuationProgressState({ state: "running", phase: "thinking", validationState: null }).step).toBe(1);
    expect(punctuationProgressState({ state: "running", phase: "validating", validationState: null }).step).toBe(2);
    expect(punctuationProgressState({ state: "completed", phase: "completed", validationState: "valid" })).toMatchObject({ step: 3, running: false, completed: true });
  });
  it("never presents rejected output as successful completion", () => {
    const state = punctuationProgressState({ state: "completed", phase: "validation_failed", validationState: "invalid_unapplied" });
    expect(state).toMatchObject({ step: 2, completed: false, running: false });
    expect(state.description).toContain("적용할 수 없습니다");
  });
  it("distinguishes stopping, canceled, and failed runs", () => {
    expect(punctuationProgressState({ state: "running", phase: "stopping", validationState: null }).title).toBe("작업을 중지하고 있어요");
    expect(punctuationProgressState({ state: "canceled", phase: "canceled", validationState: null })).toMatchObject({ running: false, completed: false, title: "표점 생성을 중지했어요" });
    expect(punctuationProgressState(null).title).toBe("표점 생성을 완료하지 못했어요");
  });
});
