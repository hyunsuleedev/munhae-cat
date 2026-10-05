import { describe, expect, it } from "vitest";
import type { DocumentListItem } from "../src/shared/munhae-api";
import { resolveContextNode } from "../src/renderer/scripts/context-node";

const master: DocumentListItem = {
  id: "master", parentId: null, depth: 0, nodeRole: "container", isMaster: true,
  title: "문집", originalTitle: null, ordinal: 0,
  sourceState: "none", punctuationState: "none", translationState: "none",
  contextCount: 1,
};
const child: DocumentListItem = {
  ...master, id: "child", parentId: master.id, depth: 1,
  nodeRole: "source_unit", isMaster: false, title: "서문",
};
const documents = [master, child];

describe("context page document selection", () => {
  it("keeps the current child and its ancestor path on a bare context URL", () => {
    expect(resolveContextNode(documents, null, child.id)).toBe(child);
  });

  it("honors explicit links including the master context", () => {
    expect(resolveContextNode(documents, master.id, child.id)).toBe(master);
    expect(resolveContextNode(documents, child.id, master.id)).toBe(child);
  });

  it("falls back to this project's master when the remembered document is absent", () => {
    expect(resolveContextNode(documents, null, "another-project-document")).toBe(master);
    expect(resolveContextNode(documents, null, null)).toBe(master);
  });

  it("does not substitute a different document for a broken explicit link", () => {
    expect(resolveContextNode(documents, "deleted", child.id)).toBeUndefined();
    expect(resolveContextNode([], null, child.id)).toBeUndefined();
  });
});
