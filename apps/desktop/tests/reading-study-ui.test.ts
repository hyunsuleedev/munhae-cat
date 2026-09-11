import { describe, expect, it, vi } from "vitest";
import type { EditorView, IpcResult, MunhaeApi, ReadingAnnotationView, ReadingCitation } from "../src/shared/munhae-api";
import { configureReadingStudy } from "../src/renderer/scripts/reading-study-ui";

const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Minimal event/element surface, following account-page-state.test.ts. No browser
// library is required to exercise actual async controller and draft ownership.
class Element extends EventTarget {
  hidden = false; disabled = false; value = ""; textContent = ""; tabIndex = 0;
  dataset: Record<string, string> = {};
  classList = { add: vi.fn(), toggle: vi.fn() };
  focus = vi.fn();
  attributes = new Map<string, string>();
  children: Element[] = [];
  private markup = "";
  constructor(private elements: Map<string, Element>, readonly selector = "") { super(); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.children = [...value.matchAll(/<button\b([^>]*)>/gu)].map(match => {
      const button = new Element(this.elements);
      for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/gu)) {
        button.attributes.set(attr[1]!, attr[2]!);
        if (attr[1]!.startsWith("data-")) button.dataset[attr[1]!.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = attr[2]!;
      }
      button.disabled = /\sdisabled(?:\s|$)/u.test(match[1]!);
      return button;
    });
  }
  replaceChildren() { this.children = []; this.markup = ""; }
  matches(selector: string) {
    if (selector.startsWith(".")) return this.attributes.get("class")?.split(" ").includes(selector.slice(1)) ?? false;
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/u);
    return !!attr && this.attributes.has(attr[1]!) && (attr[2] === undefined || this.attributes.get(attr[1]!) === attr[2]);
  }
  closest(selector: string) { return this.matches(selector) ? this : null; }
  querySelectorAll(selector: string): Element[] {
    const children = this.selector === "host" ? [...this.elements.values()].flatMap(element => element.children) : this.children;
    return children.filter(child => child.matches(selector));
  }
  querySelector(selector: string): Element | null {
    if (selector.startsWith("[")) return this.querySelectorAll(selector)[0] ?? null;
    if (this.selector === "host" && selector.startsWith("#") && !this.markup.includes(`id="${selector.slice(1)}"`)) return null;
    const key = selector.startsWith("#") || this.selector === "host" ? selector : `${this.selector}/${selector}`;
    if (!this.elements.has(key)) this.elements.set(key, new Element(this.elements, key));
    return this.elements.get(key)!;
  }
}

const sourceView = (documentId = "doc", sourceId = "source-1"): EditorView => ({
  document: { id: documentId }, source: { versionId: sourceId, contentText: "甲乙", versionNo: 1 }, punctuation: null, translation: null,
}) as EditorView;
const savedNote = (extra: Partial<ReadingAnnotationView> = {}): ReadingAnnotationView => ({
  id: "existing", documentNodeId: "doc", sourceVersionId: "source-1", codepointFrom: 0, codepointTo: 1,
  quote: "甲", reading: "갑", gloss: "기존 풀이", readingOrder: null, citation: null, lockVersion: 7,
  createdAt: "2026-09-10", updatedAt: "2026-09-10", ...extra,
});
const savedCitation = (extra: Partial<ReadingCitation> = {}): ReadingCitation => ({
  source: "libhangul", sourceLabel: "사전", entryId: "dict:甲", headword: "甲", reading: "갑", sense: "선택한 사전 뜻",
  sourceUrl: "https://example.invalid/source", license: "test", licenseUrl: null, attribution: "test", ...extra,
});

function fixture() {
  const elements = new Map<string, Element>();
  const host = new Element(elements, "host");
  const listRequests: ReturnType<typeof deferred<IpcResult<ReadingAnnotationView[]>>>[] = [];
  const saveRequests: ReturnType<typeof deferred<IpcResult<ReadingAnnotationView>>>[] = [];
  const saveReadingAnnotation = vi.fn(() => { const request = deferred<IpcResult<ReadingAnnotationView>>(); saveRequests.push(request); return request.promise; });
  const api = {
    editor: {
      listReadingAnnotations: vi.fn(() => { const request = deferred<IpcResult<ReadingAnnotationView[]>>(); listRequests.push(request); return request.promise; }),
      saveReadingAnnotation,
      archiveReadingAnnotation: vi.fn(async () => ({ ok: true, data: undefined })),
    },
    dictionary: { search: vi.fn(async ({ query }: { query: string }) => ({ ok: true, data: { entries: [{
      id: `dict:${query}`, headword: query, source: "libhangul", reading: query === "甲" ? "갑" : "을", sourceLabel: "사전",
      sourceUrl: "https://example.invalid/source", license: "test", licenseUrl: null, attribution: "test", canCite: true,
      senses: [{ text: "사전 뜻" }],
    }] } })) },
  } as unknown as MunhaeApi;
  let editable = true;
  const edited = vi.fn();
  const controller = configureReadingStudy({ api, host: host as unknown as HTMLElement, escape: String, notify: vi.fn(),
    canEdit: () => editable, changed: vi.fn(), edited });
  const element = (selector: string) => host.querySelector(selector)!;
  const click = (target: Element, extra: Record<string, unknown> = {}) => {
    const event = new Event("click", { cancelable: true });
    Object.defineProperty(event, "target", { value: target });
    for (const [key, value] of Object.entries(extra)) Object.defineProperty(event, key, { value });
    host.dispatchEvent(event);
  };
  const type = (selector: string, text: string) => { const target = element(selector); target.value = text; target.dispatchEvent(new Event("input")); };
  controller.setDocument(sourceView()); controller.setVisible(true);
  return { controller, api, host, listRequests, saveRequests, saveReadingAnnotation, edited, element, click, type,
    setEditable: (value: boolean) => { editable = value; }, sense: () => host.querySelectorAll("[data-rs-sense]")[0]! };
}

describe("reading study draft and async boundaries", () => {
  it("blocks dictionary imports until annotations load, then saves against the existing note lock", async () => {
    const f = fixture(); await flush();
    expect(f.sense().disabled).toBe(true);
    f.sense().disabled = false; f.click(f.sense()); // Guard also checks state, not just DOM styling.
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.edited).not.toHaveBeenCalled();
    const legacyGloss = "  사용자가 남긴 문맥 풀이\n원문 그대로  ";
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ gloss: legacyGloss })] }); await flush();
    expect(f.sense().disabled).toBe(false);
    f.click(f.sense());
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    const saving = f.controller.save();
    expect(f.saveReadingAnnotation).toHaveBeenCalledWith(expect.objectContaining({ id: "existing", expectedLockVersion: 7,
      gloss: legacyGloss, citation: expect.objectContaining({ headword: "甲", sense: "사전 뜻" }) }));
    f.saveRequests[0]!.resolve({ ok: true, data: savedNote({ gloss: legacyGloss, lockVersion: 8, citation: savedCitation({ sense: "사전 뜻" }) }) });
    expect(await saving).toBe(true);
  });

  it("signals actual draft edits separately from async loading and rendering", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    expect(f.edited).not.toHaveBeenCalled();
    f.type("#rsReading", "갑독음"); expect(f.edited).toHaveBeenCalledTimes(1);
    f.type("#rsOrder", "2"); expect(f.edited).toHaveBeenCalledTimes(2);
    f.click(f.sense()); expect(f.edited).toHaveBeenCalledTimes(3);
    f.element("#rsClearCitation").dispatchEvent(new Event("click")); expect(f.edited).toHaveBeenCalledTimes(4);
    f.controller.setVisible(false); f.controller.setVisible(true); await flush();
    expect(f.edited).toHaveBeenCalledTimes(4);
    expect(f.element("#rsReading").value).toBe("갑독음");
    expect(f.element("#rsOrder").value).toBe("2");
  });

  it("cannot import a sense while other editor work prevents editing", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.setEditable(false); f.click(f.sense());
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.edited).not.toHaveBeenCalled();
  });

  it("keeps a failed autosave draft and original selection instead of selecting another character", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.type("#rsReading", "보존할 독음");
    f.type("#rsOrder", "3");
    const target = f.element("#rsTokens").querySelector('[data-rs-from="1"]')!;
    f.click(target); expect(f.controller.isBusy()).toBe(true);
    f.saveRequests[0]!.resolve({ ok: false, error: { code: "conflict", message: "다른 창에서 변경되었습니다" } }); await flush();
    expect(f.element("#rsSelected").textContent).toBe("甲");
    expect(f.element("#rsReading").value).toBe("보존할 독음");
    expect(f.element("#rsOrder").value).toBe("3");
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    expect(f.element("#rsStatus").textContent).toBe("다른 창에서 변경되었습니다");
  });

  it("ignores an older document annotation response after the document changes", async () => {
    const f = fixture();
    f.controller.setDocument(sourceView("other-doc", "source-2"));
    f.listRequests[1]!.resolve({ ok: true, data: [savedNote({ id: "new-note", documentNodeId: "other-doc", sourceVersionId: "source-2", reading: "새 문서 독음", readingOrder: 4 })] });
    await flush();
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote()] }); await flush();
    expect(f.element("#rsReading").value).toBe("새 문서 독음");
    expect(f.element("#rsOrder").value).toBe("4");
    expect(f.edited).not.toHaveBeenCalled();
  });
});

describe("reading study dictionary meanings without manual gloss editing", () => {
  it("removes the manual gloss field while retaining reading and reading-order controls", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    expect(f.host.querySelector("#rsGloss")).toBeNull();
    expect(f.element("#rsReading").disabled).toBe(false);
    expect(f.element("#rsOrder").disabled).toBe(false);
  });

  it("preserves the exact legacy gloss and citation when updating a note's reading and order", async () => {
    const f = fixture();
    const legacyGloss = "  예전 문맥 풀이\n보존할 둘째 줄  ", citation = savedCitation();
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ gloss: legacyGloss, citation })] }); await flush();
    f.type("#rsReading", "수정한 독음"); f.type("#rsOrder", "2");
    const saving = f.controller.save();
    expect(f.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: "existing", expectedLockVersion: 7, reading: "수정한 독음", readingOrder: 2, gloss: legacyGloss, citation,
    }));
    f.saveRequests[0]!.resolve({ ok: true, data: savedNote({ gloss: legacyGloss, citation, reading: "수정한 독음", readingOrder: 2, lockVersion: 8 }) });
    expect(await saving).toBe(true);
    expect(f.controller.hasUnsavedDraft()).toBe(false);
  });

  it("saves a new selected dictionary meaning as a citation with an empty manual gloss", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.click(f.sense());
    const saving = f.controller.save();
    expect(f.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      documentNodeId: "doc", sourceVersionId: "source-1", codepointFrom: 0, codepointTo: 1, quote: "甲",
      gloss: "", reading: "갑", expectedLockVersion: 0, citation: expect.objectContaining({ headword: "甲", sense: "사전 뜻" }),
    }));
    f.saveRequests[0]!.resolve({ ok: true, data: savedNote({ id: "new-note", gloss: "", lockVersion: 1, citation: savedCitation({ sense: "사전 뜻" }) }) });
    expect(await saving).toBe(true);
    expect(f.controller.hasUnsavedDraft()).toBe(false);
  });

  it("shows cited senses or basic dictionary glosses on cards and cited phrase senses instead of legacy glosses", async () => {
    const f = fixture();
    f.listRequests[0]!.resolve({ ok: true, data: [
      savedNote({ gloss: "숨길 낱자 풀이", citation: savedCitation({ sense: "선택한 낱자 뜻" }) }),
      savedNote({ id: "second", codepointFrom: 1, codepointTo: 2, quote: "乙", reading: "을", gloss: "숨길 기본훈 대체 풀이" }),
      savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙", gloss: "숨길 어휘 풀이", citation: savedCitation({ entryId: "dict:甲乙", headword: "甲乙", sense: "선택한 어휘 뜻" }) }),
    ] }); await flush();
    const cards = f.element("#rsTokens").innerHTML, phrases = f.element("#rsSavedPhrases").innerHTML;
    expect(cards).toContain("선택한 낱자 뜻");
    expect(cards).toContain("사전 뜻");
    expect(cards).not.toContain("숨길 낱자 풀이");
    expect(cards).not.toContain("숨길 기본훈 대체 풀이");
    expect(phrases).toContain("선택한 어휘 뜻");
    expect(phrases).not.toContain("숨길 어휘 풀이");
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.edited).not.toHaveBeenCalled();
  });
});
