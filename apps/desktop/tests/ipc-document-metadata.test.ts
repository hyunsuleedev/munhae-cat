import { describe, expect, it } from "vitest";
import { parseCreateDocumentInput, parseUpdateDocumentMetadataInput } from "../src/main/ipc-validate";

describe("document metadata without node classification", () => {
  it.each(["container", "source_unit"] as const)("creates a %s without structure or genre", (nodeRole) => {
    const input = {
      title: "분류를 모르는 문서",
      originalTitle: null,
      parentId: "master",
      nodeRole,
      ...(nodeRole === "source_unit" ? { originKind: "paste", sourceText: "天地玄黃" } : {}),
    };
    expect(parseCreateDocumentInput(input)).toEqual(input);
    expect(parseCreateDocumentInput({ ...input, structuralKind: "section", genre: "prose" })).toEqual(input);
  });

  it("updates metadata without accepting obsolete classification fields", () => {
    const input = {
      documentNodeId: "document",
      title: "문서",
      originalTitle: null,
      authorPersonId: null,
      language: null,
      periodText: null,
      dateText: null,
      descriptionMd: null,
      sourceReference: null,
      expectedLockVersion: 1,
    };
    expect(parseUpdateDocumentMetadataInput(input)).toEqual(input);
    expect(parseUpdateDocumentMetadataInput({ ...input, structuralKind: "section", genre: "prose" })).toEqual(input);
  });
});
