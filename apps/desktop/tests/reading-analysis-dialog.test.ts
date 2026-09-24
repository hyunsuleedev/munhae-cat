import { describe, expect, it, vi } from "vitest";
import type { AppConfig, MunhaeApi } from "../src/shared/munhae-api";
import { createReadingAnalysisDialog, readingProgressState } from "../src/renderer/scripts/reading-analysis-dialog";

vi.mock("../src/renderer/scripts/translation-progress-ui", () => ({ createTranslationProgress: () => ({ update: vi.fn(), dispose: vi.fn() }) }));
vi.mock("../src/renderer/scripts/translation-setup-ui", () => ({ prepModelMarkup: () => "", changePrepModelSetting: () => false }));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Element extends EventTarget {
  id = ""; className = ""; innerHTML = ""; textContent = ""; value = "codex"; hidden = false; disabled = false; open = false;
  dataset: Record<string, string> = {};
  children = new Map<string, Element>();
  ownerDocument = { createElement: () => new Element(), body: { append: vi.fn() } };
  setAttribute = vi.fn(); focus = vi.fn(); remove = vi.fn();
  querySelector(id: string) { if (!this.children.has(id)) this.children.set(id, new Element()); return this.children.get(id)!; }
  querySelectorAll() { return []; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event("close")); }
  click() { this.dispatchEvent(new Event("click")); }
}
function fixture() {
  const trigger = new Element(), modal = new Element(); trigger.ownerDocument.createElement = () => modal;
  const config = { agentId: "codex", agentModels: { codex: { model: "selected-model", reasoning: "high", serviceTier: null }, claude: { model: "default" } } } as AppConfig;
  const app = { getConfig: vi.fn(async () => structuredClone(config)), setConfig: vi.fn(async () => config), probeAgents: vi.fn(async () => [{ agentId: "codex", installed: true, loggedIn: true }]) };
  const start = vi.fn(async () => true), cancel = vi.fn(async () => {}), review = vi.fn();
  const controller = createReadingAnalysisDialog({ api: { app } as unknown as MunhaeApi, trigger: trigger as unknown as HTMLButtonElement, start, cancel, review });
  const el = (id: string) => modal.querySelector(`#${id}`);
  return { app, start, cancel, review, controller, modal, trigger, el };
}
describe("reading analysis setup and progress dialogs", () => {
  it("opens setup without launching, then saves the selected settings before one explicit start", async () => {
    const f = fixture(); f.controller.open("문서", "平壤"); await flush();
    expect(f.modal.open).toBe(true); expect(f.modal.dataset.mode).toBe("setup");
    expect(f.start).not.toHaveBeenCalled(); expect(f.app.setConfig).not.toHaveBeenCalled();
    f.el("readingStart").click(); f.el("readingStart").click(); await flush();
    expect(f.app.setConfig).toHaveBeenCalledExactlyOnceWith({ agentId: "codex", agentModels: expect.objectContaining({ codex: { model: "selected-model", reasoning: "high", serviceTier: null } }) });
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.app.setConfig.mock.invocationCallOrder[0]).toBeLessThan(f.start.mock.invocationCallOrder[0]!);
    expect(f.modal.dataset.mode).toBe("progress");
  });
  it("does not launch after a settings save failure and keeps a retry path", async () => {
    const f = fixture(); f.app.setConfig.mockRejectedValueOnce(new Error("설정 저장 실패"));
    f.controller.open("문서", "平壤"); await flush(); f.el("readingStart").click(); await flush();
    expect(f.start).not.toHaveBeenCalled(); expect(f.el("readingError").textContent).toBe("설정 저장 실패");
    expect(f.el("readingBack").hidden).toBe(false);
  });
  it("invalidates a pending setup when the source context changes", async () => {
    const f = fixture(); let resolve!: (value: AppConfig) => void;
    f.app.getConfig.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    f.controller.open("이전 문서", "平壤"); f.controller.reset();
    resolve({ agentId: "codex" } as AppConfig); await flush();
    expect(f.modal.open).toBe(false); expect(f.start).not.toHaveBeenCalled();
    expect(f.app.setConfig).not.toHaveBeenCalled();
  });
  it("closing restores focus without canceling; cancel is an explicit action", async () => {
    const f = fixture(); f.controller.open("문서", "平壤"); await flush();
    f.el("readingClose").click(); expect(f.trigger.focus).toHaveBeenCalled(); expect(f.cancel).not.toHaveBeenCalled();
    f.el("readingCancel").click(); expect(f.cancel).toHaveBeenCalledTimes(1);
  });
  it("distinguishes preparation, running, completion and cancellation", () => {
    expect(readingProgressState(null, true)).toMatchObject({ step: 0, running: true });
    expect(readingProgressState({ state: "running", phase: "running", validationState: null })).toMatchObject({ step: 1, running: true });
    expect(readingProgressState({ state: "completed", phase: "done", validationState: "valid" })).toMatchObject({ step: 2, completed: true });
    expect(readingProgressState({ state: "canceled", phase: "done", validationState: null })).toMatchObject({ running: false, completed: false, title: "분석을 취소했어요" });
  });
});
