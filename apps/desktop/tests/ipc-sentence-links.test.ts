import { describe, expect, it } from "vitest";
import { parseSaveSentenceLinkInput } from "../src/main/ipc-validate";

const input = {
  documentNodeId: "document-1", versionId: "translation-1", sentenceId: "T1", expectedLockVersion: 2,
  spans: [{ from: 0, to: 2, quote: "𠀀甲" }, { from: 1, to: 3, quote: "甲乙" }],
};

describe("manual sentence correspondence IPC", () => {
  it("preserves Unicode quotes, their order and overlapping source ranges", () => {
    expect(parseSaveSentenceLinkInput(input)).toEqual(input);
  });

  it.each([
    { documentNodeId: "" }, { versionId: " " }, { sentenceId: "" },
    { expectedLockVersion: 0 }, { expectedLockVersion: 1.5 }, { expectedLockVersion: Number.MAX_SAFE_INTEGER + 1 },
    { spans: null }, { spans: [] }, { spans: Array(101).fill(input.spans[0]) },
    { spans: [{ from: -1, to: 1, quote: "學而" }] },
    { spans: [{ from: 0, to: 1, quote: "𠀀甲" }] },
    { spans: [{ from: 0.5, to: 2, quote: "學而" }] },
    { spans: [{ from: 0, to: 1, quote: " " }] },
    { spans: [{ from: 20_000_000, to: 20_000_001, quote: "甲" }] },
    { spans: [{ from: 0, to: 2, quote: "學而", trusted: true }] },
    { reviewedBy: "human" }, { textContent: "must not edit translation" },
  ])("rejects malformed or overbroad correction payloads: %j", (invalid) => {
    expect(() => parseSaveSentenceLinkInput({ ...input, ...invalid })).toThrow();
  });
});
