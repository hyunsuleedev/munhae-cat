import { describe, expect, it } from "vitest";
import { parseCreateContextItemInput, parseUpdateContextItemInput } from "../src/main/ipc-validate";

describe("free-text context input", () => {
  const content = { scopeId: "document-1", title: "문집 해제", contentMd: "서지와 저자 설명을 분해하지 않고 보존한다.\n출처: 자료 A", priority: 0, enabled: true };

  it("creates and updates context without requiring a classification", () => {
    expect(parseCreateContextItemInput(content)).toEqual(content);
    const update = { ...content, id: "context-1", expectedLockVersion: 2 };
    expect(parseUpdateContextItemInput(update)).toEqual(update);
    expect(parseCreateContextItemInput({ ...content, itemKind: "external_evidence" })).toEqual(content);
  });

  it("still requires the owning node, title and body", () => {
    for (const field of ["scopeId", "title", "contentMd"]) {
      expect(() => parseCreateContextItemInput({ ...content, [field]: "" })).toThrow();
    }
  });
});
