import { describe, expect, it } from "vitest";
import { EditHistory, EditorLocalStore, findReviewPlace, whitespaceMarkup } from "../src/renderer/scripts/editor-session";

function memoryStorage() {
  const data = new Map<string, string>();
  return { data, get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

describe("editor undo", () => {
  it("coalesces typing in one sentence, but separates pauses, sentences and IME boundaries", () => {
    const history = new EditHistory<string>(); history.reset("a");
    history.record("ab", "T1", 100); history.record("abc", "T1", 200);
    history.record("abcd", "T1", 1100); history.record("abcde", "T2", 1200);
    history.breakGroup(); history.record("abcdef", "T2", 1250);
    expect(history.undo()).toBe("abcde"); expect(history.undo()).toBe("abcd");
    expect(history.undo()).toBe("abc"); expect(history.undo()).toBe("a"); expect(history.canUndo).toBe(false);
  });
  it("keeps history across saves and invalidates redo after a new edit", () => {
    const history = new EditHistory<{ text: string; version: number }>(); history.reset({ text: "a", version: 1 });
    history.record({ text: "b", version: 1 }); history.replaceCurrent({ text: "b", version: 2 });
    expect(history.undo()?.text).toBe("a"); expect(history.redo()).toEqual({ text: "b", version: 2 });
    history.undo(); history.record({ text: "c", version: 2 }); expect(history.canRedo).toBe(false);
  });
  it("restores text and source spans together without sharing mutable arrays", () => {
    const before = { text: "甲𠀀\r\n乙", links: [{ spans: [{ from: 0, to: 2, quote: "甲𠀀" }] }] };
    const history = new EditHistory<typeof before>(); history.reset(before);
    before.links[0]!.spans[0]!.to = 5;
    history.record({ text: "甲\n𠀀乙", links: [] });
    const restored = history.undo()!;
    expect(restored).toEqual({ text: "甲𠀀\r\n乙", links: [{ spans: [{ from: 0, to: 2, quote: "甲𠀀" }] }] });
    restored.links.length = 0; expect(history.current()!.links).toHaveLength(1);
  });
  it("bounds history and starts a fresh baseline on document changes", () => {
    const history = new EditHistory<number>(3); history.reset(0); [1, 2, 3, 4].forEach(v => history.record(v));
    expect(history.undo()).toBe(3); expect(history.undo()).toBe(2); expect(history.undo()).toBeUndefined();
    history.reset(99); expect(history.canUndo).toBe(false); expect(history.canRedo).toBe(false);
  });
});

describe("local recovery", () => {
  const valid = (value: unknown): value is { text: string } => typeof (value as any)?.text === "string";
  it("isolates projects, documents and concurrent windows and retains incompatible bases", () => {
    const storage = memoryStorage();
    const a = new EditorLocalStore(storage, "project-A/doc", "window-1");
    const b = new EditorLocalStore(storage, "project-A/doc", "window-2");
    const other = new EditorLocalStore(storage, "project-B/doc", "window-1");
    a.recover("version-1", { text: "甲𠀀\r\n" }); b.recover("version-2", { text: "乙" }); other.recover("version-1", { text: "丙" });
    expect(a.recoveries(valid).map(r => r.base).sort()).toEqual(["version-1", "version-2"]);
    a.clearRecovery(); expect(b.recoveries(valid).map(r => r.draft.text)).toEqual(["乙"]);
    expect(other.recoveries(valid)[0]!.draft.text).toBe("丙");
  });
  it("ignores malformed records and keeps an earlier recovery if storage fills up", () => {
    const storage = memoryStorage(); const local = new EditorLocalStore(storage, "doc", "window");
    local.recover("v1", { text: "saved recovery" });
    storage.setItem(local.prefix + "recovery:bad", "{");
    local.write("recovery:invalid", { schema: 1, writer: "invalid", at: 1, base: "v1", draft: { text: 5 } });
    expect(local.recoveries(valid)).toHaveLength(1);
    storage.setItem = () => { throw new Error("quota"); };
    expect(() => local.recover("v1", { text: "new" })).toThrow("quota");
    expect(local.recoveries(valid)[0]!.draft.text).toBe("saved recovery");
  });
});

it("relocates bookmarks only at known coordinates or a unique unchanged quotation", () => {
  const sentences = [{ id: "T1", from: 0, text: "same" }, { id: "T2", from: 5, text: "same" }, { id: "T3", from: 10, text: "unique" }];
  expect(findReviewPlace({ sentenceId: "old", from: 0, quote: "same" }, sentences)).toBeNull();
  expect(findReviewPlace({ sentenceId: "T2", from: 5, quote: "same" }, sentences)).toBe("T2");
  expect(findReviewPlace({ sentenceId: "old", from: 0, quote: "unique" }, sentences)).toBe("T3");
  expect(findReviewPlace({ sentenceId: "T3", from: 10, quote: "changed" }, sentences)).toBeNull();
});

it("whitespace markers preserve original glyphs and CRLF in their text nodes", () => {
  const text = "甲𠀀 乙\t丙\r\n謚 諡";
  expect(whitespaceMarkup(text, t => t).replace(/<[^>]+>/g, "")).toBe(text);
  expect(whitespaceMarkup("<script> ", t => t.replaceAll("<", "&lt;").replaceAll(">", "&gt;"))).not.toContain("<script>");
});
