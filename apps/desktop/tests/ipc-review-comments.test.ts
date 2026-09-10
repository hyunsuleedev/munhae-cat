import { describe, expect, it } from "vitest";
import {
  parseArchiveReviewCommentInput,
  parseContextPreviewInput,
  parseCreateReviewCommentInput,
  parseStartTranslationInput,
  parseUpdateReviewCommentInput,
} from "../src/main/ipc-validate";

const comment = {
  documentNodeId: "document-1",
  translationVersionId: "translation-1",
  targetKind: "source",
  targetVersionId: "source-1",
  codepointFrom: 2,
  codepointTo: 6,
  quote: " 巖𠀀客",
  bodyMd: "여기서는 화자를 가리킨다.\n근거: 앞 구절의 질문 주체.",
};

describe("review comment IPC validation", () => {
  it("preserves exact selected text and counts non-BMP characters as codepoints", () => {
    expect(parseCreateReviewCommentInput(comment)).toEqual(comment);
    expect(parseCreateReviewCommentInput({ ...comment, targetKind: "translation", targetVersionId: "translation-1" }))
      .toMatchObject({ targetKind: "translation", targetVersionId: "translation-1" });
  });

  it.each([
    { codepointFrom: -1 },
    { codepointFrom: 2.5 },
    { codepointTo: 2 },
    { codepointTo: 1 },
    { codepointTo: 7 },
    { codepointTo: Number.NaN },
    { codepointFrom: Number.MAX_SAFE_INTEGER + 1, codepointTo: Number.MAX_SAFE_INTEGER + 5 },
    { codepointFrom: 20_000_000, codepointTo: 20_000_004 },
    { quote: "    " },
    { quote: "原".repeat(100_001), codepointTo: 100_003 },
    { bodyMd: " " },
    { bodyMd: "가".repeat(20_001) },
    { targetKind: "punctuation" },
    { documentNodeId: "" },
    { translationVersionId: " " },
    { targetVersionId: "v".repeat(81) },
  ])("rejects malformed ranges, missing provenance and oversized payloads: %j", (invalid) => {
    expect(() => parseCreateReviewCommentInput({ ...comment, ...invalid })).toThrow();
  });

  it("requires a valid optimistic lock when editing or archiving", () => {
    expect(parseUpdateReviewCommentInput({ id: "comment-1", bodyMd: "수정한 판단", expectedLockVersion: 2 }))
      .toEqual({ id: "comment-1", bodyMd: "수정한 판단", expectedLockVersion: 2 });
    expect(parseArchiveReviewCommentInput({ id: "comment-1", expectedLockVersion: 2 }))
      .toEqual({ id: "comment-1", expectedLockVersion: 2 });
    for (const expectedLockVersion of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseUpdateReviewCommentInput({ id: "comment-1", bodyMd: "수정", expectedLockVersion })).toThrow();
      expect(() => parseArchiveReviewCommentInput({ id: "comment-1", expectedLockVersion })).toThrow();
    }
    expect(() => parseUpdateReviewCommentInput({ id: "comment-1", bodyMd: "", expectedLockVersion: 1 })).toThrow();
    expect(() => parseArchiveReviewCommentInput({ id: "", expectedLockVersion: 1 })).toThrow();
  });
});

describe("translation revision IPC validation", () => {
  const revision = { baseVersionId: "translation-1", commentIds: ["comment-1", "comment-2"] };

  it("carries the same revision into preview and execution without changing initial translation input", () => {
    const context = { documentNodeId: "document-1", revision };
    expect(parseContextPreviewInput(context)).toEqual({ ...context, selections: [] });
    expect(parseStartTranslationInput({ ...context, agentId: "codex" }))
      .toEqual({ ...context, selections: [], agentId: "codex" });
    expect(parseContextPreviewInput({ documentNodeId: "document-1" }))
      .toEqual({ documentNodeId: "document-1", selections: [] });
  });

  it.each([
    null,
    [],
    {},
    { ...revision, baseVersionId: " " },
    { ...revision, baseVersionId: "v".repeat(81) },
    { ...revision, commentIds: [] },
    { ...revision, commentIds: "comment-1" },
    { ...revision, commentIds: ["comment-1", " comment-1 "] },
    { ...revision, commentIds: [""] },
    { ...revision, commentIds: [123] },
    { ...revision, commentIds: ["c".repeat(81)] },
    { ...revision, commentIds: Array.from({ length: 501 }, (_, index) => `comment-${index}`) },
    { ...revision, userPrompt: "unexpected field" },
  ])("rejects an invalid revision request: %j", (invalidRevision) => {
    expect(() => parseContextPreviewInput({ documentNodeId: "document-1", revision: invalidRevision })).toThrow();
    expect(() => parseStartTranslationInput({ documentNodeId: "document-1", revision: invalidRevision, agentId: "codex" })).toThrow();
  });

  it("does not combine revision generation with alignment of an existing version", () => {
    expect(() => parseStartTranslationInput({ documentNodeId: "document-1", revision, alignmentVersionId: "translation-1", agentId: "codex" }))
      .toThrow();
  });
});
