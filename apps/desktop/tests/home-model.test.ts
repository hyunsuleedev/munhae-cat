import { describe, expect, it } from "vitest";
import type { DocumentListItem } from "../src/shared/munhae-api";
import {
  buildHomeGroups,
  homeDocumentPath,
  homeStage,
  resolveHomeCreationParent,
  resolveHomeResume,
  resolveRecentDocument,
} from "../src/renderer/scripts/home-model";

function source(id: string, overrides: Partial<DocumentListItem> = {}): DocumentListItem {
  return {
    id, parentId: null, depth: 0, nodeRole: "source_unit", isMaster: false,
    title: id, originalTitle: null, ordinal: 0,
    sourceState: "none", punctuationState: "none", translationState: "none",
    uncertaintyCount: 0, contextCount: 0,
    ...overrides,
  };
}

function folder(id: string, overrides: Partial<DocumentListItem> = {}): DocumentListItem {
  return source(id, { nodeRole: "container", ...overrides });
}

describe("home source grouping", () => {
  it("keeps a nested source once under its first chapter, retains empty chapters, and separates direct sources", () => {
    const documents = [
      folder("master", { isMaster: true }),
      folder("volume", { parentId: "master", originalTitle: "卷一" }),
      folder("section", { parentId: "volume" }),
      source("nested", { parentId: "section" }),
      source("chapter-source", { parentId: "volume" }),
      folder("empty", { parentId: "master" }),
      source("master-source", { parentId: "master" }),
      source("root-source"),
    ];
    const groups = buildHomeGroups(documents);
    expect(groups.map(group => [group.containerId, group.title, group.documents.map(document => document.id)])).toEqual([
      ["volume", "卷一", ["nested", "chapter-source"]],
      ["empty", "empty", []],
      [null, "직접 연결된 원문", ["master-source", "root-source"]],
    ]);
    const ids = groups.flatMap(group => group.documents.map(document => document.id));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it("never counts a container or project master as translation work, even with version states", () => {
    const documents = [
      folder("master", { isMaster: true, translationState: "confirmed" }),
      folder("empty", { parentId: "master", translationState: "confirmed" }),
      source("malformed-master", { isMaster: true, translationState: "confirmed" }),
    ];
    expect(buildHomeGroups(documents)).toEqual([
      { id: "empty", title: "empty", containerId: "empty", documents: [] },
    ]);
    expect(resolveHomeResume(documents, "malformed-master", [{ title: "master" }])).toEqual({ document: null, kind: "first" });
  });

  it("uses a plain source group for a project without chapters and returns no fictitious empty group", () => {
    const document = source("first");
    expect(buildHomeGroups([document])).toEqual([
      { id: "home-direct-sources", title: "원문 문서", containerId: null, documents: [document] },
    ]);
    expect(buildHomeGroups([])).toEqual([]);
    expect(buildHomeGroups([folder("master", { isMaster: true })])).toEqual([]);
  });

  it("retains orphan sources and orphan folders without relying on depth or input ancestry order", () => {
    const nested = source("nested", { parentId: "orphan-folder", depth: 99 });
    const orphan = source("orphan", { parentId: "missing" });
    const documents = [nested, folder("orphan-folder", { parentId: "missing", depth: 3 }), orphan];
    expect(buildHomeGroups(documents).map(group => [group.containerId, group.documents.map(document => document.id)])).toEqual([
      ["orphan-folder", ["nested"]], [null, ["orphan"]],
    ]);
    expect(homeDocumentPath(nested, documents)).toBe("orphan-folder");
    expect(homeDocumentPath(orphan, documents)).toBe("");
  });

  it("groups a cycle consistently, avoids duplicating sources, and terminates path traversal", () => {
    const documents = [
      folder("a", { parentId: "b" }),
      folder("b", { parentId: "a" }),
      folder("branch", { parentId: "a" }),
      source("one", { parentId: "a" }),
      source("two", { parentId: "b" }),
      source("three", { parentId: "branch" }),
      source("self-loop", { parentId: "self-loop" }),
    ];
    expect(buildHomeGroups(documents).map(group => [group.containerId, group.documents.map(document => document.id)])).toEqual([
      ["a", ["one", "two", "three"]], [null, ["self-loop"]],
    ]);
    expect(homeDocumentPath(documents[3]!, documents)).toBe("b › a");
    expect(homeDocumentPath(documents[6]!, documents)).toBe("");
  });

  it("uses original ancestor titles, omits the master, and leaves the supplied array untouched", () => {
    const document = Object.freeze(source("text", { parentId: "section" }));
    const documents = Object.freeze([
      Object.freeze(folder("master", { isMaster: true, title: "프로젝트" })),
      Object.freeze(folder("volume", { parentId: "master", title: "권1", originalTitle: "卷一" })),
      Object.freeze(folder("section", { parentId: "volume", title: "관제" })),
      document,
    ]);
    expect(homeDocumentPath(document, documents)).toBe("卷一 › 관제");
    expect(homeDocumentPath(documents[1]!, documents)).toBe("");
    expect(buildHomeGroups(documents)[0]?.documents).toEqual([document]);
  });
});

describe("home source creation destination", () => {
  const documents = [
    folder("master", { isMaster: true }),
    folder("old-chapter", { parentId: "master" }),
    folder("current-chapter", { parentId: "master" }),
    folder("current-section", { parentId: "current-chapter" }),
    source("old-source", { parentId: "old-chapter" }),
    source("direct-source", { parentId: "master" }),
  ];

  it("uses the currently opened group instead of the source left selected in another chapter", () => {
    expect(resolveHomeCreationParent(documents, { groupId: "current-chapter", selectedId: "old-source" })).toBe("current-chapter");
  });

  it("uses the project master for the direct-sources group instead of an old selected chapter", () => {
    const group = buildHomeGroups(documents).find(item => item.containerId === null)!;
    expect(resolveHomeCreationParent(documents, { groupId: group.id, selectedId: "old-source" })).toBe("master");
  });

  it("prioritizes a valid specific container filter over its top-level group and a stale selected source", () => {
    expect(resolveHomeCreationParent(documents, {
      containerId: "current-section", groupId: "current-chapter", selectedId: "old-source",
    })).toBe("current-section");
    expect(resolveHomeCreationParent(documents, {
      containerId: "old-source", groupId: "current-chapter", selectedId: "old-source",
    })).toBe("current-chapter");
  });

  it("preserves explicit null and exact IDs for caller or backend validation", () => {
    expect(resolveHomeCreationParent(documents, { explicitParentId: null, containerId: "current-chapter" })).toBeNull();
    expect(resolveHomeCreationParent(documents, { explicitParentId: "caller-supplied-id", groupId: "current-chapter" })).toBe("caller-supplied-id");
    expect(resolveHomeCreationParent(documents, { explicitParentId: "old-chapter", containerId: "current-chapter" })).toBe("old-chapter");
  });

  it("uses the selected source's valid container parent or the selected container itself", () => {
    expect(resolveHomeCreationParent(documents, { selectedId: "old-source" })).toBe("old-chapter");
    expect(resolveHomeCreationParent(documents, { selectedId: "current-section" })).toBe("current-section");
    expect(resolveHomeCreationParent(documents, { selectedId: "direct-source" })).toBe("master");
  });

  it.each(["missing-parent", "old-source", null])("rejects invalid selected-source parent %s before falling back to the master", parentId => {
    const current = [...documents, source("invalid-parent-source", { parentId })];
    expect(resolveHomeCreationParent(current, { selectedId: "invalid-parent-source" })).toBe("master");
  });

  it("falls back safely for foreign selections and projects with no master", () => {
    expect(resolveHomeCreationParent(documents, { containerId: "foreign-container", groupId: "missing-group", selectedId: "foreign-source" })).toBe("master");
    expect(resolveHomeCreationParent([], {})).toBeNull();
    const rootSource = source("root-source");
    const group = buildHomeGroups([rootSource])[0]!;
    expect(resolveHomeCreationParent([rootSource], { groupId: group.id })).toBeNull();
    expect(resolveHomeCreationParent([source("invalid-parent", { parentId: "missing" })], { selectedId: "invalid-parent" })).toBeNull();
  });
});

describe("home work stage", () => {
  it.each(["sourceState", "punctuationState", "translationState"] as const)("prioritizes invalidated %s over a previously confirmed translation", state => {
    const document = source("text", { sourceState: "confirmed", punctuationState: "confirmed", translationState: "confirmed", [state]: "review" });
    expect(homeStage(document)).toBe("review");
  });

  it("shows the furthest non-invalidated work stage", () => {
    expect(homeStage(source("new"))).toBe("source");
    expect(homeStage(source("source", { sourceState: "confirmed" }))).toBe("source");
    expect(homeStage(source("punctuation", { punctuationState: "draft" }))).toBe("punctuation");
    expect(homeStage(source("punctuation", { punctuationState: "confirmed" }))).toBe("punctuation");
    expect(homeStage(source("translation", { translationState: "draft" }))).toBe("translation");
    expect(homeStage(source("confirmed", { translationState: "confirmed" }))).toBe("confirmed");
  });
});

describe("safe home document resumption", () => {
  it("prefers a persisted source belonging to the current document list over recent activity", () => {
    const documents = [source("first"), source("persisted"), source("recent")];
    expect(resolveHomeResume(documents, "persisted", [{ title: "recent" }])).toEqual({ document: documents[1], kind: "resume" });
  });

  it.each(["foreign-document", "folder", "master"])("rejects persisted ID %s and uses uniquely identified recent work", persistedId => {
    const documents = [
      folder("master", { isMaster: true }), folder("folder"), source("first"),
      source("recent", { title: "태상시", originalTitle: "太常寺" }),
    ];
    expect(resolveHomeResume(documents, persistedId, [{ title: "태상시" }])).toEqual({ document: documents[3], kind: "recent" });
  });

  it("never resolves an ambiguous title across chapter boundaries", () => {
    const documents = [
      source("one", { parentId: "chapter1", title: "序" }),
      source("two", { parentId: "chapter2", title: "序", originalTitle: "서문" }),
      folder("folder", { title: "序" }),
      source("unique", { title: "祭器", originalTitle: "祭器" }),
    ];
    expect(resolveRecentDocument({ title: "序" }, documents)).toBeNull();
    expect(resolveRecentDocument({ title: "祭器" }, documents)).toBe(documents[3]);
    expect(resolveHomeResume(documents, null, [{ title: "序" }, { title: "祭器" }])).toEqual({ document: documents[3], kind: "recent" });
  });

  it("does not misroute renamed or deleted history by matching only an original title", () => {
    const document = source("current", { title: "태상시", originalTitle: "太常寺" });
    expect(resolveRecentDocument({ title: "太常寺" }, [document])).toBeNull();
    expect(resolveRecentDocument({ title: "태상시" }, [document])).toBe(document);
    const sameOriginalTitle = source("other", { title: "太常寺", originalTitle: "다른 원문" });
    expect(resolveRecentDocument({ title: "太常寺" }, [document, sameOriginalTitle])).toBe(sameOriginalTitle);
  });

  it("ignores matching folder names, blank events, and stale history before an explicitly first-document fallback", () => {
    const first = source("first");
    const documents = [folder("folder", { title: "序" }), first, source("blank", { title: "" })];
    expect(resolveRecentDocument({ title: "序" }, documents)).toBeNull();
    expect(resolveRecentDocument({ title: "" }, documents)).toBeNull();
    expect(resolveHomeResume(documents, undefined, [{ title: "missing" }, { title: "序" }])).toEqual({ document: first, kind: "first" });
    expect(resolveHomeResume([], null, [{ title: "missing" }])).toEqual({ document: null, kind: "first" });
  });
});
