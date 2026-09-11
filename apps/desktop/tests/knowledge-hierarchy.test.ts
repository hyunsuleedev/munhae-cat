import { describe, expect, it } from "vitest";
import type { DocumentListItem, MaterialPreferenceView, NodeContextView } from "../src/shared/munhae-api";
import { documentPath, documentPathText, orderedDocumentNodes, materialNodeState } from "../src/renderer/scripts/knowledge-model";

function node(id: string, parentId: string | null, ordinal = 0, title = id): DocumentListItem {
  return { id, parentId, ordinal, title, originalTitle: null, depth: 0, isMaster: parentId === null,
    nodeRole: "container", sourceState: "empty", punctuationState: "empty", translationState: "empty",
    uncertaintyCount: 0, contextCount: 0 } as DocumentListItem;
}

describe("translation material node hierarchy", () => {
  it("uses arbitrary real parent depth and keeps identically named branches separate", () => {
    const docs = [node("root", null), node("a", "root", 0, "권"), node("b", "root", 1, "권"),
      node("a1", "a"), node("a2", "a1"), node("a3", "a2"), node("leaf", "a3"), node("other", "b")];
    expect(documentPath(docs, "leaf").map(item => item.id)).toEqual(["root", "a", "a1", "a2", "a3", "leaf"]);
    expect(documentPath(docs, "other").map(item => item.id)).toEqual(["root", "b", "other"]);
    expect(documentPathText(docs, "leaf")).toBe("root › 권 › a1 › a2 › a3 › leaf");
  });

  it("orders children by ordinal without moving a document into a different branch", () => {
    const docs = [node("second", "root", 2), node("leaf", "first"), node("root", null), node("first", "root", 1)];
    expect(orderedDocumentNodes(docs).map(item => item.id)).toEqual(["root", "first", "leaf", "second"]);
  });

  it("does not invent a path for absent, orphaned, or cyclic nodes", () => {
    const docs = [node("a", "b"), node("b", "a"), node("orphan", "missing")];
    for (const id of ["missing", "orphan", "a"]) expect(documentPath(docs, id)).toEqual([]);
    expect(orderedDocumentNodes(docs).map(item => item.id).sort()).toEqual(["a", "b", "orphan"]);
  });

  it("distinguishes inherited, manually selected and excluded materials without widening their scope", () => {
    const docs = [node("root", null), node("volume", "root"), node("document", "volume"), node("other", "root")];
    const item: NodeContextView = { id: "note", source: "context_item", scopeKind: "document_node", scopeId: "volume",
      title: "note", contentMd: "body", enabled: true, priority: 0, lockVersion: 1, updatedAt: "", inheritToChildren: true };
    const preference = (documentNodeId: string, excluded = false): MaterialPreferenceView => ({ documentNodeId,
      source: "context_item", sourceId: "note", referenced: true, excluded, mode: excluded ? "exclude" : "include", lockVersion: 1 });
    expect(materialNodeState(docs, item, [], "document")).toEqual({ reason: "ancestor", excluded: false, included: true });
    expect(materialNodeState(docs, item, [], "other").reason).toBeNull();
    expect(materialNodeState(docs, item, [preference("other")], "other")).toEqual({ reason: "selected", excluded: false, included: true });
    expect(materialNodeState(docs, item, [preference("document", true)], "document")).toEqual({ reason: "ancestor", excluded: true, included: false });
    expect(materialNodeState(docs, { ...item, inheritToChildren: false }, [], "document").reason).toBeNull();
    expect(materialNodeState(docs, { ...item, enabled: false }, [preference("other")], "other").included).toBe(true);
  });

  it("uses the owning document id for description preferences rather than its virtual item id", () => {
    const docs = [node("root", null), node("document", "root")];
    const item: NodeContextView = { id: "description:root", source: "document_description", scopeKind: "document_node", scopeId: "root",
      title: "description", contentMd: "body", enabled: true, priority: 0, lockVersion: 1, updatedAt: "" };
    const pref: MaterialPreferenceView = { documentNodeId: "document", source: "document_description", sourceId: "root", mode: "exclude", referenced: false, excluded: true, lockVersion: 1 };
    expect(materialNodeState(docs, item, [pref], "document").included).toBe(false);
    expect(materialNodeState(docs, item, [{ ...pref, sourceId: item.id }], "document").included).toBe(true);
  });
});
