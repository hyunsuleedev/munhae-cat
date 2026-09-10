import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentListItem, EditorView, IpcResult, MaterialsView, MunhaeApi, ResolvedMaterialView } from "../src/shared/munhae-api";
import { configureDocumentMaterials } from "../src/renderer/scripts/document-materials-ui";

vi.mock("../src/renderer/scripts/material-editor-ui", () => ({ configureMaterialEditor: () => ({
  open: vi.fn(), isBusy: () => false, hasUnsavedDraft: () => false, discard: vi.fn(),
}) }));

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
class FakeElement extends EventTarget {
  innerHTML = ""; textContent = ""; value = ""; className = ""; disabled = false; checked = false;
  open = false; isConnected = true; scrollTop = 0; dataset: Record<string, string> = {};
  private attributes = new Set<string>();
  private children = new Map<string, FakeElement>();
  focus = vi.fn();
  setAttribute(name: string) { this.attributes.add(name); }
  hasAttribute(name: string) { return this.attributes.has(name); }
  closest() { return this; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event("close")); }
  querySelector(selector: string): FakeElement {
    if (!this.children.has(selector)) this.children.set(selector, new FakeElement());
    return this.children.get(selector)!;
  }
  querySelectorAll() { return []; }
}
const documents = [
  { id: "root", parentId: null, title: "문집", isMaster: true, ordinal: 0 },
  { id: "doc-a", parentId: "root", title: "갑", isMaster: false, ordinal: 0 },
  { id: "doc-b", parentId: "root", title: "을", isMaster: false, ordinal: 1 },
] as DocumentListItem[];
const editorView = (id: string, version = "v1") => ({ document: { id }, source: { versionId: `source-${id}` }, translation: { versionId: version } }) as EditorView;
const material = (extra: Partial<ResolvedMaterialView> = {}): ResolvedMaterialView => ({
  id: "m1", source: "context_item", scopeId: "root", scopeKind: "document_node", title: "배경", contentMd: "내용", priority: 0,
  enabled: true, lockVersion: 1, updatedAt: "2026-09-10", reason: "ancestor", excluded: false, referenced: false, included: true,
  ...extra,
});
const materials = (item = material()): MaterialsView => ({ items: [item], resolved: [item], preferences: [], comments: [{
  id: "c1", documentNodeId: "doc-a", translationVersionId: "a-v1", targetKind: "source", targetVersionId: "a-source", codepointFrom: 0,
  codepointTo: 1, quote: "甲", bodyMd: "이 구절에만 적용", lockVersion: 3, createdAt: "2026-09-10", updatedAt: "2026-09-10", authorName: "검토자", materialIds: [],
}] });

function fixture() {
  const host = new FakeElement();
  const dialogs: FakeElement[] = [];
  vi.stubGlobal("HTMLInputElement", FakeElement);
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("document", {
    activeElement: null,
    querySelector: () => host,
    createElement: () => { const element = new FakeElement(); dialogs.push(element); return element; },
    body: { append: vi.fn() },
  });
  const requests: ReturnType<typeof deferred<IpcResult<MaterialsView>>>[] = [];
  const getMaterials = vi.fn(() => { const request = deferred<IpcResult<MaterialsView>>(); requests.push(request); return request.promise; });
  const setMaterialPreference = vi.fn(async () => ({ ok: true, data: undefined }));
  let view = editorView("doc-a");
  const changed = vi.fn();
  const controller = configureDocumentMaterials({ api: { knowledge: { getMaterials, setMaterialPreference } } as unknown as MunhaeApi,
    documents: () => documents, view: () => view, escape: String, notify: vi.fn(), canChange: () => true, changed,
    openPreparation: vi.fn(), openDocument: vi.fn(), openMaterials: vi.fn(),
  });
  const event = (element: FakeElement, type: string, target: FakeElement) => {
    const event = new Event(type); Object.defineProperty(event, "target", { value: target }); element.dispatchEvent(event);
  };
  const button = (attrs: Record<string, string> = {}, attribute?: string) => {
    const target = new FakeElement(); target.dataset = attrs; if (attribute) target.setAttribute(attribute); return target;
  };
  return { controller, host, dialogs, requests, changed, getMaterials, setMaterialPreference, event, button,
    setView: (id: string, version?: string) => { view = editorView(id, version); controller.setDocument(view); },
    resolve: async (index: number, value: MaterialsView) => { requests[index]!.resolve({ ok: true, data: value }); await flush(); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });
beforeEach(() => { vi.clearAllMocks(); });

describe("document material controller ownership", () => {
  it("ignores an old document response and renders the current lineage", async () => {
    const f = fixture(); f.setView("doc-a"); f.setView("doc-b");
    await f.resolve(1, materials(material({ title: "을의 배경" })));
    await f.resolve(0, materials(material({ title: "늦게 도착한 갑 자료" })));
    expect(f.host.innerHTML).toContain("을의 배경");
    expect(f.host.innerHTML).not.toContain("늦게 도착한 갑 자료");
    expect(f.host.innerHTML).toContain("현재 노드에 둔 자료");
  });

  it("uses backend effective inclusion and the actual node identity for description preferences", async () => {
    const f = fixture(); f.setView("doc-b");
    const item = material({ id: "document-description:root", source: "document_description", enabled: false, included: true });
    const data = materials(item);
    data.preferences = [{ documentNodeId: "doc-b", source: "document_description", sourceId: "root", mode: "include", referenced: true, excluded: false, lockVersion: 7 }];
    await f.resolve(0, data);
    expect(f.host.innerHTML).toContain('data-material-include="document-description:root" checked');
    const input = f.button({ materialInclude: item.id }); input.checked = false;
    f.event(f.host, "change", input); await flush();
    expect(f.setMaterialPreference).toHaveBeenCalledWith({ documentNodeId: "doc-b", source: "document_description", sourceId: "root", mode: "exclude", expectedLockVersion: 7 });
    await f.resolve(1, materials({ ...item, included: false, excluded: true }));
    expect(f.host.innerHTML).toContain("이 문서에서 제외됨");
    expect(f.changed).toHaveBeenCalledOnce();
  });

  it("keeps one-off comments separate from persistent preferences and clears only the launched document selection", async () => {
    const f = fixture(); f.setView("doc-b"); await f.resolve(0, materials());
    f.event(f.host, "click", f.button({ materialAction: "picker" })); await flush(); await f.resolve(1, materials());
    const picker = f.dialogs[0]!;
    f.event(picker, "click", f.button({ pickerKind: "comments" }));
    const selected = f.button({ materialPick: "c1" }); selected.checked = true; f.event(picker, "change", selected);
    f.event(picker, "click", f.button({}, "data-picker-confirm")); await flush();
    expect(f.controller.referenceCommentIds()).toEqual(["c1"]);
    expect(f.setMaterialPreference).not.toHaveBeenCalled();
    f.controller.clearLaunchedComments("doc-a", ["c1"]);
    expect(f.controller.referenceCommentIds()).toEqual(["c1"]);
    f.controller.clearLaunchedComments("doc-b", ["c1"]);
    expect(f.controller.referenceCommentIds()).toEqual([]);
  });

  it("requires an absent preference when creating a document's first override", async () => {
    const f = fixture(); f.setView("doc-b"); await f.resolve(0, materials());
    const input = f.button({ materialInclude: "m1" }); input.checked = false;
    f.event(f.host, "change", input); await flush();
    expect(f.setMaterialPreference).toHaveBeenCalledWith({ documentNodeId: "doc-b", source: "context_item", sourceId: "m1", mode: "exclude", expectedLockVersion: 0 });
    await f.resolve(1, materials(material({ excluded: true, included: false })));
  });

  it("drops one-off selection when the reviewed translation version changes", async () => {
    const f = fixture(); f.setView("doc-b"); await f.resolve(0, materials());
    f.event(f.host, "click", f.button({ materialAction: "picker" })); await flush(); await f.resolve(1, materials());
    const picker = f.dialogs[0]!;
    f.event(picker, "click", f.button({ pickerKind: "comments" }));
    const selected = f.button({ materialPick: "c1" }); selected.checked = true; f.event(picker, "change", selected);
    f.event(picker, "click", f.button({}, "data-picker-confirm")); await flush();
    expect(f.controller.referenceCommentIds()).toEqual(["c1"]);
    f.setView("doc-b", "v2"); await f.resolve(2, materials());
    expect(f.controller.referenceCommentIds()).toEqual([]);
  });
});
