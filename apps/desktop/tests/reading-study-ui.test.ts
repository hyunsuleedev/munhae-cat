import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { EditorView, IpcResult, MunhaeApi, ReadingAnnotationView, ReadingCitation } from "../src/shared/munhae-api";
import type { DictionaryEntry } from "../src/shared/dictionary-types";
import type { ReadingAnalysisApi, ReadingAnalysisRun } from "../src/shared/reading-analysis-types";
import { configureReadingStudy } from "../src/renderer/scripts/reading-study-ui";

const dialogs = vi.hoisted(() => [] as Array<{ start(): Promise<boolean>; open: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>);
vi.mock("../src/renderer/scripts/reading-analysis-dialog", () => ({
  createReadingAnalysisDialog: (deps: { start(): Promise<boolean> }) => {
    const dialog = { start: deps.start, open: vi.fn(), update: vi.fn(), reset: vi.fn(), dispose: vi.fn() };
    dialogs.push(dialog); return dialog;
  },
}));

const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Minimal event/element surface, following account-page-state.test.ts. No browser
// library is required to exercise actual async controller and draft ownership.
class Element extends EventTarget {
  hidden = false; disabled = false; value = ""; textContent = ""; title = ""; tabIndex = 0;
  dataset: Record<string, string> = {};
  classList = { add: vi.fn(), toggle: vi.fn() };
  focus = vi.fn();
  scrollIntoView = vi.fn();
  private popoverOpen = false;
  showPopover() {
    const event = new Event("beforetoggle");
    Object.defineProperty(event, "newState", { value: "open" });
    this.dispatchEvent(event); this.popoverOpen = true; this.dispatchEvent(new Event("toggle"));
  }
  hidePopover() { this.popoverOpen = false; this.dispatchEvent(new Event("toggle")); }
  attributes = new Map<string, string>();
  children: Element[] = [];
  private markup = "";
  private descendants = new Map<string, Element>();
  constructor(private elements: Map<string, Element>, readonly selector = "") { super(); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  get innerHTML() { return this.markup; }
  set innerHTML(value: string) {
    this.markup = value;
    this.textContent = value.replace(/<[^>]*>/gu, "");
    this.descendants.clear();
    this.children = [...value.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)].map(match => {
      const button = new Element(this.elements);
      for (const attr of match[1]!.matchAll(/([\w-]+)="([^"]*)"/gu)) {
        button.attributes.set(attr[1]!, attr[2]!);
        if (attr[1]!.startsWith("data-")) button.dataset[attr[1]!.slice(5).replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())] = attr[2]!;
      }
      button.disabled = /\sdisabled(?:\s|$)/u.test(match[1]!);
      button.innerHTML = match[2]!;
      return button;
    });
  }
  replaceChildren() { this.children = []; this.markup = ""; }
  matches(selector: string) {
    if (selector === ":popover-open") return this.popoverOpen;
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
    if (this.selector !== "host" && selector.startsWith(".")) {
      if (!this.descendants.has(selector)) {
        const span = [...this.markup.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gu)]
          .find(match => match[1]!.match(/class="([^"]*)"/u)?.[1]?.split(" ").includes(selector.slice(1)));
        const child = new Element(this.elements);
        if (span) {
          for (const attr of span[1]!.matchAll(/([\w-]+)="([^"]*)"/gu)) child.setAttribute(attr[1]!, attr[2]!);
          child.title = child.getAttribute("title") ?? "";
          child.innerHTML = span[2]!;
        }
        this.descendants.set(selector, child);
      }
      return this.descendants.get(selector)!;
    }
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
  quote: "甲", reading: "갑", gloss: "기존 풀이", readingOrder: null, citation: null, translationQuote: null, lockVersion: 7,
  createdAt: "2026-09-10", updatedAt: "2026-09-10", ...extra,
});
const savedCitation = (extra: Partial<ReadingCitation> = {}): ReadingCitation => ({
  source: "libhangul", sourceLabel: "사전", entryId: "dict:甲", headword: "甲", reading: "갑", sense: "선택한 사전 뜻",
  sourceUrl: "https://example.invalid/source", license: "test", licenseUrl: null, attribution: "test", ...extra,
});

const dictionaryEntry = (query: string, extra: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
  id: `dict:${query}`, headword: query, kind: "character", source: "libhangul", reading: query === "甲" ? "갑" : "을", sourceLabel: "사전",
  sourceUrl: "https://example.invalid/source", license: "test", licenseUrl: null, attribution: "test", canCite: true,
  senses: [{ text: "사전 뜻" }], ...extra,
});

function fixture(input = sourceView(), dictionaryEntries: (query: string) => DictionaryEntry[] | Promise<DictionaryEntry[]> = query => [dictionaryEntry(query)], research?: ReadingAnalysisApi) {
  const elements = new Map<string, Element>();
  const host = new Element(elements, "host");
  const listRequests: ReturnType<typeof deferred<IpcResult<ReadingAnnotationView[]>>>[] = [];
  const saveRequests: ReturnType<typeof deferred<IpcResult<ReadingAnnotationView>>>[] = [];
  const saveReadingAnnotation = vi.fn(() => { const request = deferred<IpcResult<ReadingAnnotationView>>(); saveRequests.push(request); return request.promise; });
  const api = {
    research,
    editor: {
      listReadingAnnotations: vi.fn(() => { const request = deferred<IpcResult<ReadingAnnotationView[]>>(); listRequests.push(request); return request.promise; }),
      saveReadingAnnotation,
      archiveReadingAnnotation: vi.fn(async () => ({ ok: true, data: undefined })),
    },
    dictionary: { search: vi.fn(async ({ query }: { query: string }) => ({ ok: true, data: { entries: await dictionaryEntries(query) } })) },
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
  controller.setDocument(input); controller.setVisible(true);
  return { controller, api, host, listRequests, saveRequests, saveReadingAnnotation, edited, element, click, type,
    setEditable: (value: boolean) => { editable = value; }, sense: () => host.querySelectorAll("[data-rs-sense]")[0]! };
}

describe("reading study draft and async boundaries", () => {
  it("keeps glyph variants intact in short previews and searches beyond the preview", async () => {
    const input = sourceView();
    input.source.contentText = "甲".repeat(14) + "禰\u{E0100}" + "𥊑後半搜尋。乙。";
    const f = fixture(input); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.element("#rsUnitPicker").showPopover();
    expect(f.element("#rsUnitCount").textContent).toBe("1 / 2");
    const options = () => f.element("#rsUnitList").querySelectorAll("[data-rs-unit]");
    expect(options()).toHaveLength(2);
    expect(options()[0]!.textContent).toContain("甲".repeat(14) + "禰\u{E0100}…");
    expect(options()[0]!.textContent).not.toContain("後半搜尋");
    f.type("#rsUnitSearch", "後半搜尋");
    expect(options()).toHaveLength(1);
    expect(options()[0]!.dataset.rsUnit).toBe("0");
    f.type("#rsUnitSearch", "無結果");
    expect(options()).toHaveLength(0);
    expect(f.element("#rsUnitNoResults").hidden).toBe(false);
    expect(f.element("#rsUnitSearch").getAttribute("aria-activedescendant")).toBeNull();
  });

  it("selects a searched passage with Enter and restores the picker with its current row", async () => {
    const input = sourceView(); input.source.contentText = "甲。乙。";
    const f = fixture(input); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.element("#rsUnitPicker").showPopover(); f.type("#rsUnitSearch", "2");
    const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value: "Enter" });
    f.element("#rsUnitSearch").dispatchEvent(event); await flush();
    expect(f.element("#rsUnitCount").textContent).toBe("2 / 2");
    expect(f.element("#rsSelected").textContent).toBe("乙");
    expect(f.element("#rsNext").disabled).toBe(true);
    expect(f.element("#rsPrevious").disabled).toBe(false);
    expect(f.element("#rsUnitPicker").matches(":popover-open")).toBe(false);
    expect(f.element("#rsUnit").focus).toHaveBeenCalled();
    f.element("#rsUnitPicker").showPopover();
    expect(f.element("#rsUnitSearch").value).toBe("");
    expect(f.element("#rsUnitSearch").getAttribute("aria-activedescendant")).toBe("rsUnitOption1");
    expect(f.element("#rsUnitList").querySelectorAll("[data-rs-unit]")[1]!.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the current passage and unsaved draft when saving before a picker selection fails", async () => {
    const input = sourceView(); input.source.contentText = "甲。乙。";
    const f = fixture(input); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.type("#rsReading", "수정한 독음");
    f.element("#rsUnitPicker").showPopover(); f.type("#rsUnitSearch", "2");
    const option = f.element("#rsUnitList").querySelectorAll("[data-rs-unit]")[0]!;
    const event = new Event("click"); Object.defineProperty(event, "target", { value: option });
    f.element("#rsUnitList").dispatchEvent(event); await flush();
    expect(f.element("#rsUnit").disabled).toBe(true);
    expect(option.disabled).toBe(true);
    f.saveRequests[0]!.resolve({ ok: false, error: { code: "conflict", message: "저장 충돌" } }); await flush();
    expect(f.element("#rsUnitCount").textContent).toBe("1 / 2");
    expect(f.element("#rsReading").value).toBe("수정한 독음");
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    expect(f.element("#rsUnitPicker").matches(":popover-open")).toBe(true);
    expect(f.element("#rsStatus").textContent).toBe("저장 충돌");
    expect(option.disabled).toBe(false);
  });

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

describe("reading study aligned rows", () => {
  function tokenMarkup(f: ReturnType<typeof fixture>, from: number) {
    const buttons = [...f.element("#rsTokens").innerHTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gu)];
    const token = buttons.find(button => button[1]!.includes(`data-rs-from="${from}"`));
    expect(token, `token at source position ${from}`).toBeDefined();
    return token![2]!;
  }
  function spanText(markup: string, className: string) {
    const spans = [...markup.matchAll(/<span\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gu)];
    const span = spans.find(item => item[1]!.split(" ").includes(className));
    expect(span, `span with class ${className}`).toBeDefined();
    return span![2]!;
  }

  it("keeps basic dictionary glosses separate from selected meanings in aligned rows", async () => {
    const f = fixture();
    await flush();
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ citation: savedCitation({ sense: "이 위치에서 선택한 뜻" }) })] });
    await flush();
    const selected = tokenMarkup(f, 0), unselected = tokenMarkup(f, 1);
    expect(f.host.innerHTML).toContain('role="toolbar" aria-label="구절 연구 도구"');
    expect(f.host.innerHTML).not.toContain('id="rsCards"');
    expect(f.element("#rsTokens").innerHTML).toContain('style="grid-column:1"');
    expect(spanText(selected, "rs-token-basic")).toBe("사전 뜻");
    expect(spanText(selected, "rs-token-gloss")).toBe("이 위치에서 선택한 뜻");
    expect(spanText(unselected, "rs-token-basic")).toBe("사전 뜻");
    expect(spanText(unselected, "rs-token-gloss")).toBe("");
    expect(unselected).toContain('class="rs-token-gloss rs-unselected"');
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    expect(f.edited).not.toHaveBeenCalled();
  });

  it("keeps the full basic gloss accessible when delayed dictionary results fill a compact preview", async () => {
    const dictionary = deferred<DictionaryEntry[]>();
    const f = fixture(sourceView(), query => query === "甲" ? dictionary.promise : [dictionaryEntry(query)]);
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ citation: savedCitation({ sense: "저장한 선택 뜻" }) })] });
    await flush();
    const token = f.element("#rsTokens").querySelector('[data-rs-from="0"]')!;
    const basic = token.querySelector(".rs-token-basic")!;
    expect(basic.innerHTML).toBe("");
    const citationMarkup = f.element("#rsCitationBody").innerHTML;

    dictionary.resolve([dictionaryEntry("甲", { senses: [{ text: "첫 훈, 둘째 훈" }, { text: "셋째 훈" }] })]);
    await flush();
    const assertCompactGloss = (node: Element) => {
      expect(node.innerHTML).toMatch(/^첫 훈<small\b/u);
      expect(node.innerHTML).toContain(">외 2</small>");
      expect(node.innerHTML).not.toContain("둘째 훈");
      expect(node.innerHTML).not.toContain("셋째 훈");
      expect(node.title).toBe("사전 기본 훈: 첫 훈, 둘째 훈 · 셋째 훈");
      expect(node.getAttribute("aria-label")).toBe(node.title);
    };
    assertCompactGloss(basic);
    expect(token.querySelector(".rs-token-gloss")!.textContent).toBe("저장한 선택 뜻");
    expect(f.element("#rsCitationBody").innerHTML).toBe(citationMarkup);
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.edited).not.toHaveBeenCalled();

  });

  it("preserves an unsaved inspector draft when switching display order", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.type("#rsReading", "보존할 독음");
    f.type("#rsOrder", "4");
    f.click(f.sense());
    const citationMarkup = f.element("#rsCitationBody").innerHTML;
    expect(f.edited).toHaveBeenCalledTimes(3);

    for (const id of ["#rsReadingOrder", "#rsSourceOrder"]) {
      f.element(id).dispatchEvent(new Event("click"));
      expect(f.element(id).getAttribute("aria-pressed")).toBe("true");
      expect(f.element("#rsSelected").textContent).toBe("甲");
      expect(f.element("#rsReading").value).toBe("보존할 독음");
      expect(f.element("#rsOrder").value).toBe("4");
      expect(f.element("#rsCitationBody").innerHTML).toBe(citationMarkup);
      expect(f.controller.hasUnsavedDraft()).toBe(true);
      expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
      expect(f.edited).toHaveBeenCalledTimes(3);
    }
  });

  it("uses a shared meaning cell for a phrase while preserving single-character records", async () => {
    const f = fixture();
    const character = savedNote({ citation: savedCitation({ sense: "글자에 저장된 뜻" }), readingOrder: 2 });
    const phrase = savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙", reading: "갑을", citation: savedCitation({ sense: "단어로 선택한 뜻" }) });
    f.listRequests[0]!.resolve({ ok: true, data: [character, savedNote({ id: "second", codepointFrom: 1, codepointTo: 2, quote: "乙", readingOrder: 1 }), phrase] }); await flush();
    // Members of a saved word keep their own meaning row; the word's meaning sits in a separate row below.
    expect(spanText(tokenMarkup(f, 0), "rs-token-gloss")).toBe("글자에 저장된 뜻");
    expect(spanText(tokenMarkup(f, 1), "rs-token-gloss")).toBe("기존 풀이");
    expect(tokenMarkup(f, 1)).toContain("rs-token-basic");
    const marker = f.element("#rsTokens").querySelector('[data-rs-phrase="phrase"]')!;
    expect(marker.innerHTML).toContain("甲乙 · 갑을");
    expect(marker.innerHTML).toContain("단어로 선택한 뜻");
    f.click(marker); await flush();
    expect(f.element("#rsSelected").textContent).toBe("甲乙");
    expect(f.element("#rsCitationBody").innerHTML).toContain("단어로 선택한 뜻");
    // Reversing the members must restore individual meanings, not merge wrong columns.
    f.element("#rsReadingOrder").dispatchEvent(new Event("click"));
    expect(f.element("#rsTokens").querySelector('[data-rs-phrase="phrase"]')).toBeNull();
    expect(spanText(tokenMarkup(f, 0), "rs-token-gloss")).toBe("글자에 저장된 뜻");
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    expect(f.controller.hasUnsavedDraft()).toBe(false);
  });

  it("shows a record's memo under a word or glyph only when no dictionary sense is cited, and in the inspector", async () => {
    const input = sourceView(); input.source.contentText = "甲乙丙";
    const f = fixture(input);
    const phrase = savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙", reading: "갑을", gloss: "  어휘에 남긴 AI 해석\n둘째 줄  " });
    const cited = savedNote({ id: "cited", codepointFrom: 2, codepointTo: 3, quote: "丙", reading: "병", gloss: "무시될 메모", citation: savedCitation({ headword: "丙", sense: "인용한 뜻" }) });
    f.listRequests[0]!.resolve({ ok: true, data: [phrase, cited] }); await flush();
    const marker = f.element("#rsTokens").querySelector('[data-rs-phrase="phrase"]')!;
    expect(marker.innerHTML).toContain('class="rs-group-gloss rs-note-gloss" title="어휘에 남긴 AI 해석\n둘째 줄">어휘에 남긴 AI 해석\n둘째 줄</span>');
    expect(spanText(tokenMarkup(f, 2), "rs-token-gloss")).toBe("인용한 뜻");
    expect(tokenMarkup(f, 2)).not.toContain("rs-note-gloss");
    expect(f.element("#rsMemo").hidden).toBe(true);

    f.click(marker); await flush();
    expect(f.element("#rsMemo").hidden).toBe(false);
    expect(f.element("#rsMemoBody").textContent).toBe("어휘에 남긴 AI 해석\n둘째 줄");
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="2"]')!); await flush();
    expect(f.element("#rsMemo").hidden).toBe(false);
    expect(f.element("#rsMemoBody").textContent).toBe("무시될 메모");
    // The word's memo belongs to the word row; member glyphs keep their own, empty meaning cells.
    expect(spanText(tokenMarkup(f, 0), "rs-token-gloss")).toBe("");
    expect(tokenMarkup(f, 0)).not.toContain("어휘에 남긴 AI 해석");
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
  });

  it("selects and saves the exact repeated phrase occurrence from its inline marker", async () => {
    const input = sourceView(); input.source.contentText = "甲乙甲乙";
    const f = fixture(input);
    const first = savedNote({ id: "first-phrase", codepointTo: 2, quote: "甲乙", reading: "첫 어휘", lockVersion: 3 });
    const second = savedNote({ id: "second-phrase", codepointFrom: 2, codepointTo: 4, quote: "甲乙", reading: "둘째 어휘", lockVersion: 11 });
    f.listRequests[0]!.resolve({ ok: true, data: [first, second] }); await flush();

    const marker = f.element("#rsTokens").querySelector('[data-rs-phrase="second-phrase"]');
    expect(marker).not.toBeNull();
    f.click(marker!); await flush();
    expect(f.element("#rsSelected").textContent).toBe("甲乙");
    expect(f.element("#rsPosition").textContent).toBe("3–4번째 위치");
    expect(f.element("#rsReading").value).toBe("둘째 어휘");
    expect(f.element("#rsTokens").querySelectorAll("[data-rs-from]")).toHaveLength(4);
    const selectedMarker = f.element("#rsTokens").querySelector('[data-rs-phrase="second-phrase"]')!;
    expect(selectedMarker).not.toBe(marker);
    expect(selectedMarker.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });

    f.type("#rsReading", "둘째 어휘 수정");
    const key = new Event("keydown", { cancelable: true });
    Object.defineProperties(key, { target: { value: selectedMarker }, key: { value: "ArrowRight" } });
    f.element("#rsTokens").dispatchEvent(key); await flush();
    expect(key.defaultPrevented).toBe(false);
    expect(f.element("#rsPosition").textContent).toBe("3–4번째 위치");
    expect(f.element("#rsReading").value).toBe("둘째 어휘 수정");
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();

    const saving = f.controller.save();
    expect(f.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: "second-phrase", documentNodeId: "doc", sourceVersionId: "source-1",
      codepointFrom: 2, codepointTo: 4, quote: "甲乙", reading: "둘째 어휘 수정", expectedLockVersion: 11,
    }));
    f.saveRequests[0]!.resolve({ ok: true, data: { ...second, reading: "둘째 어휘 수정", lockVersion: 12 } });
    expect(await saving).toBe(true);
  });
});

describe("reading study dictionary meanings without manual gloss editing", () => {
  it("marks only the exact cited source, entry and sense as selected and clears that state", async () => {
    const f = fixture(sourceView(), query => [
      dictionaryEntry(query, { id: "shared-id", senses: [{ text: "같은 뜻" }, { text: "다른 뜻" }] }),
      dictionaryEntry(query, { id: "shared-id", source: "wiktionary", senses: [{ text: "같은 뜻" }] }),
      dictionaryEntry(query, { id: "other-id", senses: [{ text: "같은 뜻" }] }),
    ]);
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ citation: savedCitation({ entryId: "shared-id", sense: "같은 뜻" }) })] });
    await flush();
    const senses = () => f.host.querySelectorAll("[data-rs-sense]");
    const selected = () => senses().map(button => button.getAttribute("aria-pressed"));
    expect(selected()).toEqual(["true", "false", "false", "false"]);

    f.click(senses()[2]!);
    expect(selected()).toEqual(["false", "false", "true", "false"]);
    f.element("#rsClearCitation").dispatchEvent(new Event("click"));
    expect(selected()).toEqual(["false", "false", "false", "false"]);
    expect(f.element("#rsCitation").hidden).toBe(true);
  });

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

  it("shows cited senses in aligned rows and concise readings on saved phrases", async () => {
    const f = fixture();
    f.listRequests[0]!.resolve({ ok: true, data: [
      savedNote({ gloss: "숨길 낱자 풀이", citation: savedCitation({ sense: "선택한 낱자 뜻" }) }),
      savedNote({ id: "second", codepointFrom: 1, codepointTo: 2, quote: "乙", reading: "을", gloss: "숨길 기본훈 대체 풀이" }),
      savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙", gloss: "숨길 어휘 풀이", citation: savedCitation({ entryId: "dict:甲乙", headword: "甲乙", sense: "선택한 어휘 뜻" }) }),
    ] }); await flush();
    const rows = f.element("#rsTokens").innerHTML, phrases = f.element("#rsSavedPhrases").innerHTML;
    expect(rows).toContain("선택한 낱자 뜻");
    expect(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!.querySelector(".rs-token-basic")!.textContent).toBe("사전 뜻");
    expect(rows).not.toContain("숨길 낱자 풀이");
    // 乙 has no cited sense, so its own memo shows in its meaning cell beneath the word row.
    expect(rows).toContain('class="rs-token-gloss rs-note-gloss" title="숨길 기본훈 대체 풀이">숨길 기본훈 대체 풀이</span>');
    expect(phrases).not.toContain("선택한 어휘 뜻");
    expect(phrases).toContain("甲乙 묶음 삭제");
    expect(phrases).not.toContain("숨길 어휘 풀이");
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.edited).not.toHaveBeenCalled();
  });
  it("deletes the clicked phrase with its lock while retaining individual character notes", async () => {
    const f = fixture();
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote(), savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙", reading: "갑을" })] }); await flush();
    f.click(f.element("#rsSavedPhrases").querySelector('[data-rs-delete-phrase="phrase"]')!); await flush();
    expect(f.api.editor.archiveReadingAnnotation).toHaveBeenCalledExactlyOnceWith({ id: "phrase", expectedLockVersion: 7 });
    expect(f.element("#rsSavedPhrases").innerHTML).toBe("");
    expect(f.element("#rsTokens").innerHTML).toContain("저장된 기록 있음");
  });

  it("blocks phrase deletion while editing is unavailable", async () => {
    const f = fixture();
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙" })] }); await flush();
    f.setEditable(false);
    f.click(f.element("#rsSavedPhrases").querySelector('[data-rs-delete-phrase="phrase"]')!); await flush();
    expect(f.api.editor.archiveReadingAnnotation).not.toHaveBeenCalled();
  });

});

describe("reading study optional AI actions", () => {
  const analysisRun = (extra: Partial<ReadingAnalysisRun> = {}): ReadingAnalysisRun => ({
    id: "analysis", documentNodeId: "doc", sourceVersionId: "source-1", translationVersionId: null,
    sourceHash: createHash("sha256").update("甲乙").digest("hex"), ranges: [{ from: 0, to: 2, quote: "甲乙" }],
    agentId: "codex", createdAt: "2026-09-23", state: "completed", detail: "분석 완료", error: null,
    result: { summary: "현재 구절 분석", suggestions: [{ id: "one", from: 0, to: 1, quote: "甲", reading: "갑독음", readingOrder: null,
      citation: savedCitation({ sense: "사전에서 확인한 뜻" }), translationQuote: null, explanation: "별도로 검토할 AI 해석", caution: "문맥 확인", applied: false }] }, ...extra,
  });
  function researchFixture(latest: ReadingAnalysisRun | null = null) {
    const start = deferred<IpcResult<ReadingAnalysisRun>>(), apply = deferred<IpcResult<ReadingAnnotationView>>();
    const api = {
      latestReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: latest })),
      startReadingAnalysis: vi.fn(() => start.promise),
      getReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: latest ?? analysisRun() })),
      cancelReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: analysisRun({ state: "canceled" }) })),
      applyReadingAnalysis: vi.fn(() => apply.promise),
    } satisfies ReadingAnalysisApi;
    return { api, start, apply };
  }

  it("starts only from the explicit button after saving the draft, using the current unit only", async () => {
    const research = researchFixture(), input = sourceView(); input.source.contentText = "甲。乙。";
    const f = fixture(input, undefined, research.api);
    f.element("#rsAnalyze").dispatchEvent(new Event("click")); await flush();
    expect(research.api.startReadingAnalysis).not.toHaveBeenCalled();
    f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="0"]')!); await flush();
    expect(research.api.startReadingAnalysis).not.toHaveBeenCalled();

    f.type("#rsReading", "저장할 독음");
    f.element("#rsAnalyze").dispatchEvent(new Event("click")); await flush();
    expect(dialogs.at(-1)!.open).toHaveBeenCalledTimes(1);
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    expect(research.api.startReadingAnalysis).not.toHaveBeenCalled();
    void dialogs.at(-1)!.start(); await flush();
    expect(f.saveReadingAnnotation).toHaveBeenCalledTimes(1);
    expect(research.api.startReadingAnalysis).not.toHaveBeenCalled();
    f.saveRequests[0]!.resolve({ ok: false, error: { code: "conflict", message: "풀이 저장 실패" } }); await flush();
    expect(f.element("#rsReading").value).toBe("저장할 독음");
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    expect(research.api.startReadingAnalysis).not.toHaveBeenCalled();

    f.element("#rsAnalyze").dispatchEvent(new Event("click")); await flush();
    void dialogs.at(-1)!.start(); await flush();
    f.saveRequests[1]!.resolve({ ok: true, data: savedNote({ reading: "저장할 독음", gloss: "" }) }); await flush();
    expect(research.api.startReadingAnalysis).toHaveBeenCalledExactlyOnceWith({ documentNodeId: "doc", expectedSourceVersionId: "source-1",
      expectedTranslationVersionId: null, ranges: [{ from: 0, to: 2, quote: "甲。" }] });
    f.controller.setVisible(false);
    research.start.resolve({ ok: true, data: analysisRun({ state: "running", result: null }) }); await flush();
    expect(research.api.cancelReadingAnalysis).toHaveBeenCalledExactlyOnceWith("analysis");
    expect(f.element("#rsAnalysisPanel").hidden).toBe(true);
  });

  it("keeps AI proposals separate and only adopts on request without replacing another selected character", async () => {
    const result = analysisRun(), research = researchFixture(result);
    const f = fixture(sourceView(), undefined, research.api);
    f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    await vi.waitFor(() => expect(f.host.querySelectorAll("[data-rs-ai-apply]")).toHaveLength(1));
    expect(research.api.startReadingAnalysis).not.toHaveBeenCalled();
    expect(research.api.applyReadingAnalysis).not.toHaveBeenCalled();
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain("AI 해석");
    // The grid previews the proposal as a proposal, never as a saved meaning.
    expect(f.element("#rsTokens").innerHTML).toContain('class="rs-token-gloss rs-proposed" title="AI 제안: 사전에서 확인한 뜻">사전에서 확인한 뜻');
    expect(f.element("#rsTokens").innerHTML).toContain("rs-ai-mark");
    expect(f.element("#rsTokens").innerHTML).not.toContain('class="rs-token-gloss" title="사전에서 확인한 뜻"');
    expect(f.element("#rsTokens").innerHTML).not.toContain("저장된 기록 있음");

    f.type("#rsReading", "내가 편집 중인 독음");
    const blocked = f.host.querySelectorAll("[data-rs-ai-apply]")[0]!;
    expect(blocked.disabled).toBe(true);
    blocked.disabled = false; f.click(blocked); await flush();
    expect(research.api.applyReadingAnalysis).not.toHaveBeenCalled();
    expect(f.element("#rsReading").value).toBe("내가 편집 중인 독음");
    f.element("#rsDiscard").dispatchEvent(new Event("click"));
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!); await flush();
    f.click(f.host.querySelectorAll("[data-rs-ai-apply]")[0]!);
    await vi.waitFor(() => expect(research.api.applyReadingAnalysis).toHaveBeenCalledExactlyOnceWith({ runId: "analysis", suggestionId: "one" }));
    expect(f.controller.isBusy()).toBe(true);
    research.apply.resolve({ ok: true, data: savedNote({ reading: "갑독음", gloss: "", citation: result.result!.suggestions[0]!.citation }) }); await flush();
    expect(f.controller.isBusy()).toBe(false);
    expect(f.element("#rsSelected").textContent).toBe("乙");
    expect(f.element("#rsReading").value).toBe("을");
    expect(f.element("#rsTokens").innerHTML).toContain('class="rs-token-gloss" title="사전에서 확인한 뜻"');
    expect(f.element("#rsTokens").innerHTML).not.toContain("rs-proposed");
    expect(f.element("#rsTokens").innerHTML).not.toContain("rs-ai-mark");
    expect(f.element("#rsTokens").innerHTML).not.toContain("별도로 검토할 AI 해석");
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain("채택됨");
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    f.controller.setVisible(false);
  });

  it("adopts proposals for empty positions automatically after an analysis requested here, then the rest on request", async () => {
    const run = analysisRun({ result: { summary: "두 위치", suggestions: [
      { id: "one", from: 0, to: 1, quote: "甲", reading: "갑독음", readingOrder: null, citation: savedCitation({ sense: "갑의 뜻" }), translationQuote: null, explanation: "", caution: "", applied: false },
      { id: "two", from: 1, to: 2, quote: "乙", reading: "을독음", readingOrder: 2, citation: savedCitation({ headword: "乙", sense: "을의 뜻" }), translationQuote: null, explanation: "", caution: "", applied: false },
      { id: "three", from: 0, to: 2, quote: "甲乙", reading: "갑을", readingOrder: null, citation: null, translationQuote: null, explanation: "사전에 없는 묶음", caution: "", applied: false },
    ] } });
    const start = deferred<IpcResult<ReadingAnalysisRun>>(), applied: string[] = [];
    const api = {
      latestReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: null })),
      startReadingAnalysis: vi.fn(() => start.promise),
      getReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })),
      cancelReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: analysisRun({ state: "canceled" }) })),
      applyReadingAnalysis: vi.fn(async ({ suggestionId }: { suggestionId: string }) => {
        applied.push(suggestionId);
        const item = run.result!.suggestions.find(entry => entry.id === suggestionId)!;
        return { ok: true as const, data: savedNote({ id: `note-${suggestionId}`, codepointFrom: item.from, codepointTo: item.to, quote: item.quote, reading: item.reading, readingOrder: item.readingOrder, gloss: "", citation: item.citation }) };
      }),
    } satisfies ReadingAnalysisApi;
    const f = fixture(sourceView(), undefined, api);
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ reading: "직접 쓴 독음" })] }); await flush();
    expect(f.element("#rsAutoAdopt").checked).toBe(true);

    f.element("#rsAnalyze").dispatchEvent(new Event("click")); await flush();
    void dialogs.at(-1)!.start(); await flush();
    start.resolve({ ok: true, data: run });
    await vi.waitFor(() => expect(applied).toEqual(["two"]));
    await vi.waitFor(() => expect(f.controller.isBusy()).toBe(false));
    expect(f.element("#rsStatus").textContent).toBe("AI 제안 1개를 채택했습니다. 사전 근거 없는 어휘 묶음 1개는 검토용으로 남겼습니다.");
    expect(f.element("#rsReading").value).toBe("직접 쓴 독음");
    expect(f.element("#rsAdoptAll").hidden).toBe(false);
    expect(f.element("#rsAdoptAll").textContent).toBe("남은 제안 2개 모두 채택");
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain("현재 저장 · 직접 쓴 독음");
    expect(f.element("#rsTokens").innerHTML).toContain('class="rs-token-gloss" title="을의 뜻"');
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();

    f.element("#rsAdoptAll").dispatchEvent(new Event("click"));
    await vi.waitFor(() => expect(applied).toEqual(["two", "one", "three"]));
    await vi.waitFor(() => expect(f.controller.isBusy()).toBe(false));
    expect(f.element("#rsReading").value).toBe("갑독음");
    expect(f.element("#rsAdoptAll").hidden).toBe(true);
    expect(f.element("#rsAnalysisSuggestions").innerHTML).not.toContain("rs-ai-current");
    f.controller.setVisible(false);
  });

  it("adopts only reading orders for saved characters whose number differs, without marking proposals adopted", async () => {
    const run = analysisRun({ result: { summary: "순서", suggestions: [
      { id: "one", from: 0, to: 1, quote: "甲", reading: "갑독음", readingOrder: 2, citation: null, translationQuote: null, explanation: "", caution: "", applied: false },
      { id: "two", from: 1, to: 2, quote: "乙", reading: "을독음", readingOrder: 1, citation: null, translationQuote: null, explanation: "", caution: "", applied: false },
    ] } });
    const calls: unknown[] = [];
    const api = {
      latestReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })), startReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })),
      getReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })), cancelReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })),
      applyReadingAnalysis: vi.fn(async (input: unknown) => { calls.push(input); return { ok: true as const, data: savedNote({ id: "existing", reading: "직접 쓴 독음", readingOrder: 2, lockVersion: 8 }) }; }),
    } satisfies ReadingAnalysisApi;
    const f = fixture(sourceView(), undefined, api);
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ reading: "직접 쓴 독음", readingOrder: null })] }); await flush();
    await vi.waitFor(() => expect(f.host.querySelectorAll("[data-rs-ai-apply]")).toHaveLength(2));
    expect(f.element("#rsAdoptOrders").hidden).toBe(false);
    expect(f.element("#rsAdoptOrders").textContent).toBe("풀이 순서만 채택 1");

    f.element("#rsAdoptOrders").dispatchEvent(new Event("click"));
    await vi.waitFor(() => expect(calls).toEqual([{ runId: "analysis", suggestionId: "one", orderOnly: true }]));
    await vi.waitFor(() => expect(f.controller.isBusy()).toBe(false));
    expect(f.element("#rsStatus").textContent).toBe("풀이 순서 1개를 채택했습니다.");
    expect(f.element("#rsOrder").value).toBe("2");
    expect(f.element("#rsReading").value).toBe("직접 쓴 독음");
    expect(f.element("#rsAdoptOrders").hidden).toBe(true);
    expect(f.element("#rsAnalysisSuggestions").innerHTML).not.toContain("채택됨");
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    f.controller.setVisible(false);
  });

  it("does not auto-adopt restored results or while a draft is being edited", async () => {
    const research = researchFixture(analysisRun());
    research.api.getReadingAnalysis.mockImplementation(async () => ({ ok: true as const, data: analysisRun({ id: "fresh" }) }));
    const f = fixture(sourceView(), undefined, research.api);
    f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    await vi.waitFor(() => expect(f.host.querySelectorAll("[data-rs-ai-apply]")).toHaveLength(1));
    expect(research.api.applyReadingAnalysis).not.toHaveBeenCalled();
    expect(f.element("#rsAdoptAll").textContent).toBe("남은 제안 1개 모두 채택");

    f.element("#rsAnalyze").dispatchEvent(new Event("click")); await flush();
    void dialogs.at(-1)!.start(); await flush();
    research.start.resolve({ ok: true, data: analysisRun({ id: "fresh", state: "running", result: null }) });
    await vi.waitFor(() => expect(f.element("#rsReading").disabled).toBe(false));
    expect(f.element("#rsAiTab").innerHTML).toBe("AI 분석 중…");
    f.type("#rsReading", "편집 중");
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    await vi.waitFor(() => expect(f.element("#rsStatus").textContent).toContain("자동 채택하지 않았습니다"), { timeout: 3000 });
    expect(research.api.applyReadingAnalysis).not.toHaveBeenCalled();
    expect(f.element("#rsReading").value).toBe("편집 중");
    expect(f.element("#rsAdoptAll").disabled).toBe(true);
    f.controller.setVisible(false);
  });

  it("keeps restored proposals behind the dictionary tab and brings a newly requested analysis to the front", async () => {
    const research = researchFixture(analysisRun()), f = fixture(sourceView(), undefined, research.api);
    f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    await vi.waitFor(() => expect(f.host.querySelectorAll("[data-rs-ai-apply]")).toHaveLength(1));
    expect(f.element("#rsAiTab").hidden).toBe(false);
    expect(f.element("#rsAiTab").innerHTML).toBe('AI 제안 <span class="cnt">1</span>');
    expect(f.element("#rsAiTab").getAttribute("aria-selected")).toBe("false");
    expect(f.element("#rsAnalysisPanel").hidden).toBe(true);
    expect(f.element("#rsDictionarySection").hidden).toBe(false);
    expect(f.element("#rsProposalHint").hidden).toBe(false);
    expect(f.element("#rsProposalHint").textContent).toBe("이 위치에 AI 제안 1개 · 보기");
    expect(f.element("#rsReading").disabled).toBe(false);

    f.element("#rsProposalHint").dispatchEvent(new Event("click"));
    expect(f.element("#rsAnalysisPanel").hidden).toBe(false);
    expect(f.element("#rsDictionarySection").hidden).toBe(true);
    expect(f.element("#rsProposalHint").hidden).toBe(true);
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain('class="rs-ai-suggestion is-current"');
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!); await flush();
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain('class="rs-ai-suggestion"');
    expect(f.element("#rsProposalHint").hidden).toBe(true);

    f.click(f.host.querySelectorAll("[data-rs-ai-select]")[0]!); await flush();
    expect(f.element("#rsSelected").textContent).toBe("甲");
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain('class="rs-ai-suggestion is-current"');
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();

    f.element("#rsDictionaryTab").dispatchEvent(new Event("click"));
    expect(f.element("#rsAnalysisPanel").hidden).toBe(true);
    f.click(f.host.querySelectorAll("[data-rs-ai-apply]")[0]!);
    await vi.waitFor(() => expect(research.api.applyReadingAnalysis).toHaveBeenCalledTimes(1));
    research.apply.resolve({ ok: false, error: { code: "cas_conflict", message: "현재 풀이가 변경되었습니다." } }); await flush();
    expect(f.element("#rsAnalysisPanel").hidden).toBe(true);
    expect(f.element("#rsAnalysisError").textContent).toBe("현재 풀이가 변경되었습니다.");

    f.element("#rsAnalyze").dispatchEvent(new Event("click")); await flush();
    void dialogs.at(-1)!.start(); await flush();
    expect(f.element("#rsAnalysisPanel").hidden).toBe(false);
    expect(f.element("#rsAiTab").innerHTML).toBe("AI 분석 중…");
    research.start.resolve({ ok: true, data: analysisRun({ id: "new-analysis" }) });
    await vi.waitFor(() => expect(f.element("#rsAiTab").innerHTML).toBe('AI 제안 <span class="cnt">1</span>'));
    expect(f.element("#rsAnalysisPanel").hidden).toBe(false);
    expect(f.element("#rsAiTab").getAttribute("aria-selected")).toBe("true");
    f.controller.setVisible(false);
    expect(f.element("#rsAiTab").hidden).toBe(true);
    expect(f.element("#rsDictionarySection").hidden).toBe(false);
  });
});

describe("reading study translation links", () => {
  const linkedView = (): EditorView => ({
    document: { id: "doc" }, source: { versionId: "source-1", contentText: "甲乙", versionNo: 1 }, punctuation: null,
    translation: { versionId: "translation-1", versionNo: 1, textContent: "갑과 을이다.", isCurrentDependencies: true, state: "draft", textLayout: { state: "ready", error: null,
      sentences: [{ id: "T1", from: 0, to: 7, text: "갑과 을이다." }], links: [{ sentenceId: "T1", spans: [{ from: 0, to: 2, quote: "甲乙" }], needsReview: false }] } },
  }) as EditorView;

  it("highlights only the selected record's translation part and previews an exact-range proposal's link", async () => {
    const run: ReadingAnalysisRun = { id: "analysis", documentNodeId: "doc", sourceVersionId: "source-1", translationVersionId: "translation-1",
      sourceHash: createHash("sha256").update("甲乙").digest("hex"), ranges: [{ from: 0, to: 2, quote: "甲乙" }], agentId: "codex", createdAt: "2026-09-24",
      state: "completed", detail: "완료", error: null, result: { summary: "대응", suggestions: [
        { id: "one", from: 1, to: 2, quote: "乙", reading: "을", readingOrder: null, citation: null, translationQuote: "을이다", explanation: "을", caution: "", applied: false },
      ] } };
    const api = {
      latestReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })), startReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })),
      getReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })), cancelReadingAnalysis: vi.fn(async () => ({ ok: true as const, data: run })),
      applyReadingAnalysis: vi.fn(async () => ({ ok: false as const, error: { code: "unused", message: "unused" } })),
    } satisfies ReadingAnalysisApi;
    const f = fixture(linkedView(), undefined, api);
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ translationQuote: "갑과" })] }); await flush();
    await vi.waitFor(() => expect(f.host.querySelectorAll("[data-rs-ai-apply]")).toHaveLength(1));
    expect(f.element("#rsTranslation").innerHTML).toBe('<mark class="rs-translation-hit" title="甲 번역 대응">갑과</mark> 을이다.');
    expect(f.element("#rsLinkBody").textContent).toBe("「갑과」");
    expect(f.element("#rsClearLink").hidden).toBe(false);
    expect(f.element("#rsAnalysisSuggestions").innerHTML).toContain("번역 대응 · 「을이다」");

    f.click(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!); await flush();
    expect(f.element("#rsTranslation").innerHTML).toBe('갑과 <mark class="rs-translation-hit rs-proposed" title="AI 제안 · 乙 번역 대응">을이다</mark>.');
    expect(f.element("#rsClearLink").hidden).toBe(true);
    expect(f.element("#rsLinkBody").textContent).toBe("번역 본문에서 해당 부분을 드래그한 뒤 연결하세요.");
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();

    f.click(f.element("#rsTokens").querySelector('[data-rs-from="0"]')!); await flush();
    f.element("#rsClearLink").dispatchEvent(new Event("click"));
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    // The test element keeps stale markup when textContent is assigned; the plain text is what a browser would show.
    expect(f.element("#rsTranslation").textContent).toBe("갑과 을이다.");
    const saving = f.controller.save();
    expect(f.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "existing", translationQuote: null }));
    f.saveRequests[0]!.resolve({ ok: true, data: savedNote({ translationQuote: null, lockVersion: 8 }) });
    expect(await saving).toBe(true);
    f.controller.setVisible(false);
  });

  it("falls back to the source text written inside the translation, expanding to the Korean word before the parentheses", async () => {
    const view = linkedView(); view.source.contentText = "平壤都";
    view.translation!.textContent = "평양(平壤)은 도읍이다."; view.translation!.textLayout!.sentences = [{ id: "T1", from: 0, to: 13, text: "평양(平壤)은 도읍이다." }];
    view.translation!.textLayout!.links = [{ sentenceId: "T1", spans: [{ from: 0, to: 3, quote: "平壤都" }], needsReview: false }];
    const f = fixture(view);
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ id: "word", codepointTo: 2, quote: "平壤", reading: "평양" })] }); await flush();
    expect(f.element("#rsTranslation").innerHTML).toBe('<mark class="rs-translation-hit rs-inferred" title="원문 표기 일치 · 平">평양(平壤)</mark>은 도읍이다.');
    expect(f.element("#rsLinkSelection").hidden).toBe(false);
    expect(f.element("#rsLinkSelection").textContent).toBe("「평양(平壤)」 연결");
    f.element("#rsLinkSelection").dispatchEvent(new Event("click"));
    expect(f.controller.hasUnsavedDraft()).toBe(true);
    expect(f.element("#rsLinkBody").textContent).toBe("「평양(平壤)」");
    expect(f.element("#rsTranslation").innerHTML).toBe('<mark class="rs-translation-hit" title="平 번역 대응">평양(平壤)</mark>은 도읍이다.');
    f.element("#rsDiscard").dispatchEvent(new Event("click"));
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="2"]')!); await flush();
    expect(f.element("#rsTranslation").textContent).toBe("평양(平壤)은 도읍이다.");
    expect(f.element("#rsLinkSelection").hidden).toBe(true);
  });

  it("does not highlight a link whose text no longer occurs in the translation", async () => {
    const f = fixture(linkedView());
    f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ translationQuote: "예전 번역" })] }); await flush();
    expect(f.element("#rsTranslation").textContent).toBe("갑과 을이다.");
    expect(f.element("#rsLinkBody").textContent).toBe("「예전 번역」");
  });
});

describe("reading study progress and quick entry", () => {
  it("saves an unedited dictionary reading only through the explicit save control", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    expect(f.element("#rsReading").value).toBe("갑");
    expect(f.controller.hasUnsavedDraft()).toBe(false);
    expect(f.element("#rsSave").disabled).toBe(false);
    expect(f.element("#rsSaveState").textContent).toBe("사전 독음을 확인했으면 저장하세요");
    expect(await f.controller.save()).toBe(true);
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!); await flush();
    expect(f.saveReadingAnnotation).not.toHaveBeenCalled();
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="0"]')!); await flush();

    const submit = new Event("submit", { cancelable: true }); f.element("#rsForm").dispatchEvent(submit);
    expect(f.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ codepointFrom: 0, codepointTo: 1, quote: "甲", reading: "갑", citation: null, expectedLockVersion: 0 }));
    f.saveRequests[0]!.resolve({ ok: true, data: savedNote({ id: "confirmed", gloss: "", lockVersion: 1 }) }); await flush();
    expect(f.element("#rsSaveState").textContent).toBe("프로젝트에 저장됨");
    expect(f.element("#rsSave").disabled).toBe(true);
    expect(f.element("#rsVersion").textContent).toBe("원문 V1 · 풀이 1/2");
  });

  it("shows how many characters of each passage are glossed", async () => {
    const input = sourceView(); input.source.contentText = "甲乙。丙。";
    const f = fixture(input); f.listRequests[0]!.resolve({ ok: true, data: [savedNote({ id: "phrase", codepointTo: 2, quote: "甲乙" })] }); await flush();
    expect(f.element("#rsVersion").textContent).toBe("원문 V1 · 풀이 2/2");
    f.element("#rsUnitPicker").showPopover();
    const options = f.element("#rsUnitList").querySelectorAll("[data-rs-unit]");
    expect(options[0]!.innerHTML).toContain('class="rs-unit-progress is-done" aria-label="풀이 2/2">2/2</span>');
    expect(options[1]!.innerHTML).toContain('class="rs-unit-progress" aria-label="풀이 0/1"></span>');
  });

  it("numbers reading order by click sequence and saves each step", async () => {
    const f = fixture(); f.listRequests[0]!.resolve({ ok: true, data: [] }); await flush();
    expect(f.element("#rsOrderMode").textContent).toBe("순서 매기기");
    f.element("#rsReadingOrder").dispatchEvent(new Event("click"));
    f.element("#rsOrderMode").dispatchEvent(new Event("click"));
    expect(f.element("#rsOrderMode").getAttribute("aria-pressed")).toBe("true");
    expect(f.element("#rsSourceOrder").getAttribute("aria-pressed")).toBe("true");
    expect(f.element("#rsOrderMode").textContent).toBe("순서 매기는 중 · 다음 1");

    f.click(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!); await flush();
    expect(f.element("#rsSelected").textContent).toBe("乙");
    expect(f.element("#rsOrder").value).toBe("1");
    expect(f.saveReadingAnnotation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ codepointFrom: 1, codepointTo: 2, quote: "乙", reading: "을", readingOrder: 1 }));
    f.saveRequests[0]!.resolve({ ok: true, data: savedNote({ id: "second", codepointFrom: 1, codepointTo: 2, quote: "乙", reading: "을", readingOrder: 1, gloss: "", lockVersion: 1 }) }); await flush();
    expect(f.element("#rsOrderMode").textContent).toBe("순서 매기는 중 · 다음 2");

    f.click(f.element("#rsTokens").querySelector('[data-rs-from="0"]')!); await flush();
    expect(f.saveReadingAnnotation).toHaveBeenCalledTimes(2);
    expect(f.saveReadingAnnotation).toHaveBeenLastCalledWith(expect.objectContaining({ quote: "甲", readingOrder: 2 }));
    f.saveRequests[1]!.resolve({ ok: false, error: { code: "conflict", message: "순서 저장 실패" } }); await flush();
    expect(f.element("#rsOrderMode").textContent).toBe("순서 매기는 중 · 다음 2");
    expect(f.element("#rsStatus").textContent).toBe("순서 저장 실패");
    expect(f.controller.hasUnsavedDraft()).toBe(true);

    f.element("#rsOrderMode").dispatchEvent(new Event("click"));
    expect(f.element("#rsOrderMode").getAttribute("aria-pressed")).toBe("false");
    expect(f.element("#rsOrderMode").textContent).toBe("순서 매기기");
    f.element("#rsDiscard").dispatchEvent(new Event("click"));
    f.click(f.element("#rsTokens").querySelector('[data-rs-from="1"]')!); await flush();
    expect(f.saveReadingAnnotation).toHaveBeenCalledTimes(2);
  });
});
