import { describe, expect, it } from "vitest";
import { filterSidebarBranches, readSidebarSnapshot, sidebarAncestors, sidebarStorageKey } from "../src/renderer/scripts/sidebar-model";

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
