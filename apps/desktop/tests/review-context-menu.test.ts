import { describe, expect, it } from "vitest";
import {
  reviewContextMenuPosition,
  selectionContainsPoint,
  sourceSnapshotIsCurrent,
  type ReviewSourceSnapshot,
  type ReviewSourceState,
} from "../src/renderer/scripts/review-context-menu";

describe("selected phrase context menu", () => {
  it("opens only inside actual selected line fragments", () => {
    const rects = [
      { left: 100, right: 280, top: 30, bottom: 52 },
      { left: 20, right: 130, top: 60, bottom: 82 },
    ];
    expect(selectionContainsPoint(rects, 200, 42)).toBe(true);
    expect(selectionContainsPoint(rects, 70, 75)).toBe(true);
    expect(selectionContainsPoint(rects, 70, 42)).toBe(false);
    expect(selectionContainsPoint(rects, 200, 75)).toBe(false);
    expect(selectionContainsPoint(rects, 110, 56)).toBe(false);
    expect(selectionContainsPoint(rects, Number.NaN, 42)).toBe(false);
    expect(selectionContainsPoint([], 100, 40)).toBe(false);
  });

  it("does not treat an empty range rectangle as a selection", () => {
    expect(selectionContainsPoint([{ left: 10, right: 10, top: 20, bottom: 40 }], 10, 30)).toBe(false);
    expect(selectionContainsPoint([{ left: 10, right: 20, top: 20, bottom: 20 }], 15, 20)).toBe(false);
  });

  it("places the menu above and left when it reaches the viewport edges", () => {
    expect(reviewContextMenuPosition(1290, 840, 208, 120, 1311, 866)).toEqual({ left: 1082, top: 720 });
    expect(reviewContextMenuPosition(250, 320, 208, 120, 1311, 866)).toEqual({ left: 250, top: 320 });
    expect(reviewContextMenuPosition(-10, -20, 208, 120, 1311, 866)).toEqual({ left: 8, top: 8 });
    expect(reviewContextMenuPosition(400, 100, 208, 120, 300, 160)).toEqual({ left: 84, top: 8 });
  });

  const state: ReviewSourceState = {
    documentNodeId: "doc-1", sourceVersionId: "source-1", punctuationVersionId: "punctuation-1",
    translationVersionId: "translation-1", sourceText: "𠮷甲\r\n乙𠮷丙",
  };
  const snapshot: ReviewSourceSnapshot = {
    documentNodeId: state.documentNodeId, sourceVersionId: state.sourceVersionId,
    punctuationVersionId: state.punctuationVersionId, translationVersionId: state.translationVersionId,
    from: 5, to: 6, quote: "𠮷",
  };

  it("uses the selected occurrence and Unicode source coordinates after native selection is lost", () => {
    expect(sourceSnapshotIsCurrent(snapshot, state)).toBe(true);
    expect(sourceSnapshotIsCurrent({ ...snapshot, from: 0, to: 1 }, state)).toBe(true);
    expect(sourceSnapshotIsCurrent({ ...snapshot, from: 6, to: 7 }, state)).toBe(false);
    expect(sourceSnapshotIsCurrent({ ...snapshot, from: 5, to: 7 }, state)).toBe(false);
  });

  it.each(["documentNodeId", "sourceVersionId", "punctuationVersionId", "translationVersionId"] as const)(
    "rejects the menu snapshot after %s changes",
    field => expect(sourceSnapshotIsCurrent(snapshot, { ...state, [field]: "changed" })).toBe(false),
  );

  it("rejects a changed source, deleted document, empty quote, or invalid range", () => {
    expect(sourceSnapshotIsCurrent(snapshot, { ...state, sourceText: "𠮷甲\r\n乙甲丙" })).toBe(false);
    expect(sourceSnapshotIsCurrent(snapshot, null)).toBe(false);
    for (const patch of [{ from: -1 }, { from: 5.5 }, { to: 5 }, { to: 100 }, { quote: "" }, { quote: " " }]) {
      expect(sourceSnapshotIsCurrent({ ...snapshot, ...patch }, state)).toBe(false);
    }
  });

  it("supports reference search when no translation exists", () => {
    expect(sourceSnapshotIsCurrent({ ...snapshot, translationVersionId: null }, { ...state, translationVersionId: null })).toBe(true);
  });
});
