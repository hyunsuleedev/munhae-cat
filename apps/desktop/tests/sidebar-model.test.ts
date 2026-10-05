import { describe, expect, it } from "vitest";
import { dropPlacement, dropZone, filterSidebarBranches, readSidebarSnapshot, sidebarAncestors, sidebarStorageKey } from "../src/renderer/scripts/sidebar-model";

const tree = [{ id: "master", docId: "master", lbl: "관서악부", kids: [
  { id: "context:master", contextFor: "master", lbl: "문맥" },
  { id: "chapter", docId: "chapter", lbl: "서문", kids: [
    { id: "source", docId: "source", lbl: "序", searchText: "개선 비교 序", kids: [{ id: "context:source", contextFor: "source", lbl: "문맥" }] },
    { id: "other", docId: "other", lbl: "다른 글" },
  ] },
] }];

describe("sidebar navigation model", () => {
  it("isolates packages and projects including copies with the same project ID", () => {
    expect(sidebarStorageKey({ projectId: "a", packagePath: "/one" })).not.toBe(sidebarStorageKey({ projectId: "a", packagePath: "/two" }));
    expect(sidebarStorageKey({ projectId: "a", packagePath: "/one" })).not.toBe(sidebarStorageKey({ projectId: "b", packagePath: "/one" }));
  });
  it("restores explicit collapsed state and discards malformed storage fields", () => {
    expect(readSidebarSnapshot(JSON.stringify({ expanded: [["master", false], ["source", true], ["bad", 1], null], focus: "source", scroll: 170 }))).toEqual({ expanded: [["master", false], ["source", true]], focus: "source", scroll: 170 });
    expect(readSidebarSnapshot("broken")).toEqual({ expanded: [], focus: null, scroll: 0 });
    expect(readSidebarSnapshot('{"expanded":{},"scroll":-20,"focus":12}')).toEqual({ expanded: [], focus: null, scroll: 0 });
  });
  it("matches alternate titles and ancestor paths while retaining only the matching branch", () => {
    const before = JSON.stringify(tree);
    const results = filterSidebarBranches(tree, "관서악부 개선");
    expect(results[0]?.kids?.map(node => node.id)).toEqual(["chapter"]);
    expect(results[0]?.kids?.[0]?.kids?.map(node => node.id)).toEqual(["source"]);
    expect(JSON.stringify(tree)).toBe(before);
    expect(filterSidebarBranches(tree, "없음")).toEqual([]);
    expect(filterSidebarBranches(tree, "")).toBe(tree);
  });
  it("finds descendants when searching for a folder and normalizes Korean composition", () => {
    const results = filterSidebarBranches(tree, "서문".normalize("NFD"));
    expect(results[0]?.kids?.[0]?.kids?.map(node => node.id)).toEqual(["source", "other"]);
  });
  it("reveals only ancestors, including the document itself when opening its context", () => {
    expect(sidebarAncestors(tree, "source")).toEqual(["master", "chapter"]);
    expect(sidebarAncestors(tree, "context:source")).toEqual(["master", "chapter", "source"]);
    expect(sidebarAncestors(tree, "master")).toEqual([]);
    expect(sidebarAncestors(tree, "missing")).toBeNull();
  });
});

describe("sidebar drag and drop", () => {
  const node = (id: string, parentId: string | null, ordinal: number, nodeRole: "container" | "source_unit" = "source_unit") =>
    ({ id, parentId, ordinal, nodeRole, isMaster: parentId === null });
  // root: a, folder(inner), b, c
  const docs = [node("root", null, 0, "container"), node("a", "root", 0), node("folder", "root", 1, "container"),
    node("inner", "folder", 0), node("b", "root", 2), node("c", "root", 3)];

  it("splits a row into edges and a middle that only folders accept", () => {
    expect(dropZone(docs[1]!, 0.3, false)).toBe("before");
    expect(dropZone(docs[1]!, 0.7, false)).toBe("after");
    expect(dropZone(docs[2]!, 0.1, false)).toBe("before");
    expect(dropZone(docs[2]!, 0.5, false)).toBe("into");
    expect(dropZone(docs[2]!, 0.9, false)).toBe("after");
    // An expanded folder's lower edge sits on its first child.
    expect(dropZone(docs[2]!, 0.9, true)).toBe("into");
    expect(dropZone(docs[0]!, 0.1, true)).toBe("into");
  });

  it("places a node before the following sibling, or at the end of a folder", () => {
    expect(dropPlacement(docs, "c", "a", "before")).toEqual({ parentId: "root", beforeId: "a" });
    expect(dropPlacement(docs, "a", "b", "after")).toEqual({ parentId: "root", beforeId: "c" });
    expect(dropPlacement(docs, "a", "c", "after")).toEqual({ parentId: "root", beforeId: null });
    expect(dropPlacement(docs, "c", "folder", "into")).toEqual({ parentId: "folder", beforeId: null });
    expect(dropPlacement(docs, "inner", "a", "after")).toEqual({ parentId: "root", beforeId: "folder" });
    expect(dropPlacement(docs, "a", "root", "into")).toEqual({ parentId: "root", beforeId: null });
  });

  it("refuses drops that change nothing or would put a folder inside itself", () => {
    expect(dropPlacement(docs, "b", "folder", "after")).toBeNull();
    expect(dropPlacement(docs, "b", "c", "before")).toBeNull();
    expect(dropPlacement(docs, "b", "b", "after")).toBeNull();
    expect(dropPlacement(docs, "c", "root", "into")).toBeNull();
    expect(dropPlacement(docs, "inner", "folder", "into")).toBeNull();
    expect(dropPlacement(docs, "folder", "folder", "into")).toBeNull();
    expect(dropPlacement(docs, "folder", "inner", "before")).toBeNull();
    expect(dropPlacement(docs, "a", "b", "into")).toBeNull();
    expect(dropPlacement(docs, "root", "a", "before")).toBeNull();
    expect(dropPlacement(docs, "a", "root", "before")).toBeNull();
  });
});
