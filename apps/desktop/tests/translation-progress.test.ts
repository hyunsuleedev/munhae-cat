import { t, ui } from "../src/renderer/scripts/i18n";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createTranslationProgress, translationProgressState, translationElapsed, translationRunLabel } from "../src/renderer/scripts/translation-progress-ui";
import type { AiRunView } from "../src/shared/munhae-api";

vi.mock("../src/renderer/scripts/translation-particles", () => ({
  createTranslationParticles: () => ({ update: vi.fn(), dispose: vi.fn() }),
}));

const source = readFileSync(new URL("../src/renderer/scripts/editor.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.Latest, true);
const production = ["phaseLabel", "validationLabel", "renderAiRunPanel", "receiveAiRun"].map(name => {
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing function: ${name}`);
  return declaration.getText(ast);
}).join("\n");

it("keeps translation progress visible and busy until sentence alignment finishes", async () => {
  const elements = new Map<string, any>();
  const must = (id: string) => {
    if (!elements.has(id)) elements.set(id, { dataset: {}, attributes: {}, hidden: false, open: true,
      close: vi.fn(), setAttribute(name: string, value: string) { this.attributes[name] = value; } });
    return elements.get(id);
  };
  const loadEditor = vi.fn(async () => {});
  const poll = vi.fn();
  const scheduleFinal = vi.fn();
  const clearPoll = vi.fn();
  const receive = new Function("must", "loadEditor", "scheduleAiPoll", "clearAiPoll", "scheduleFinal", "t", "ui", "translationProgressState", `
    let aiRun = null, aiStarting = false, aiCanceling = false, aiActionError = null;
    const view = { document: { id: 'doc' } };
    const handledAiTerminals = new Set(), finalizingAiTerminals = new Set(), translationShown = new Set();
    const hasUnsavedChanges = () => false, setWorkspace = () => {}, setView = () => {};
    const window = { setTimeout: scheduleFinal };
    const renderPrepActivity = () => {};
    const prepProgress = { update: () => {} };
    const renderPreparationControls = () => renderAiRunPanel();
    ${ts.transpileModule(production, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
    return receiveAiRun;
  `)(must, loadEditor, poll, clearPoll, scheduleFinal, t, ui, translationProgressState);
  const run = { messageId: "run", documentNodeId: "doc", startedAt: "2026-09-10", state: "running", validationState: "valid" };
  must("#prepStatus").textContent = "연결됨";
  for (const phase of ["streaming", "translation_saved", "aligning"]) {
    receive({ ...run, phase });
    await Promise.resolve();
    expect(must("#prepRunPanel").hidden).toBe(false);
    expect(must("#prepRunMeter").attributes["aria-busy"]).toBe("true");
    expect(must("#dlgPrepare").close).not.toHaveBeenCalled();
    if (phase !== "streaming") {
      expect(must("#prepRunState").textContent).toBe("문장을 연결하는 중");
      expect(must("#prepRunPhase").textContent).toBe("원문과 번역을 연결하고 있어요");
    }
  }
  expect(loadEditor).not.toHaveBeenCalled();
  expect(poll).toHaveBeenCalledTimes(3);
  expect(scheduleFinal).not.toHaveBeenCalled();
  receive({ ...run, state: "completed", phase: "completed" });
  expect(must("#prepRunMeter").attributes["aria-busy"]).toBe("false");
  expect(clearPoll).toHaveBeenCalledOnce();
  expect(scheduleFinal).toHaveBeenCalledOnce();
  expect(must("#prepStatus").textContent).toBe("연결됨");
});

it("advances from actual phases, without completing when translation is saved before alignment", () => {
  const run = { phase: "queued", state: "running" as const, validationState: null };
  expect(translationProgressState(null, true).step).toBe(0);
  for (const phase of ["preparing", "assembling", "spawning"]) expect(translationProgressState({ ...run, phase }).step).toBe(0);
  for (const phase of ["thinking", "streaming", "validating", "applying"]) expect(translationProgressState({ ...run, phase }).step).toBe(1);
  for (const phase of ["translation_saved", "aligning"]) {
    expect(translationProgressState({ ...run, phase, validationState: "valid" })).toMatchObject({ step: 2, running: true, completed: false });
  }
});

it("keeps a background indicator through alignment and removes it for every terminal state", () => {
  const run = { state: "running" as const, phase: "streaming", validationState: null };
  expect(translationRunLabel(null, true)).toBe("번역 준비 중");
  expect(translationRunLabel(run)).toBe("AI 번역 중");
  for (const phase of ["translation_saved", "aligning"]) expect(translationRunLabel({ ...run, phase })).toBe("문장 연결 중");
  expect(translationRunLabel(run, false, true)).toBe("번역 중지 중");
  expect(translationRunLabel({ ...run, phase: "stopping" })).toBe("번역 중지 중");
  for (const state of ["completed", "failed", "canceled"] as const) expect(translationRunLabel({ ...run, state })).toBeNull();
  expect(translationRunLabel(null)).toBeNull();
});

it("distinguishes saved, invalid, failed and canceled results without implying successful completion", () => {
  const run = { phase: "completed", state: "completed" as const, validationState: "valid" as const };
  expect(translationProgressState(run)).toMatchObject({ step: 3, running: false, completed: true });
  expect(translationProgressState({ ...run, validationState: "invalid_unapplied" })).toMatchObject({ completed: false, title: "번역을 적용하지 못했어요" });
  expect(translationProgressState({ ...run, validationState: "needs_review" }).title).toBe("번역 결과를 검토해 주세요");
  for (const state of ["failed", "canceled"] as const) expect(translationProgressState({ ...run, state, phase: state })).toMatchObject({ running: false, completed: false });
  expect(translationProgressState({ ...run, state: "running", phase: "stopping" }).title).toBe("작업을 중지하고 있어요");
});

it("uses authoritative timestamps, including completed runs and long or invalid durations", () => {
  expect(translationElapsed("2026-09-19T12:00:00Z", "2026-09-19T12:05:28Z")).toBe("05:28");
  expect(translationElapsed(0, 3_661_000)).toBe("61:01");
  expect(translationElapsed(1000, 0)).toBe("00:00");
  expect(translationElapsed("invalid", Date.now())).toBe("00:00");
});

it("keeps the clock running across frequent status updates and pauses it when hidden or finished", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-19T12:00:00Z"));
  const listeners = new Map<string, () => void>();
  const documentState = { hidden: false, addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) };
  vi.stubGlobal("document", documentState);
  let onMutation = () => {};
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { onMutation = callback; }
    observe() {}
    disconnect() {}
  });
  let elapsedText = "";
  const elapsed = { get textContent() { return elapsedText; }, set textContent(value: string) { elapsedText = value; } };
  const writes = vi.spyOn(elapsed, "textContent", "set");
  const steps = Array.from({ length: 4 }, () => ({
    classList: { toggle: vi.fn() }, setAttribute: vi.fn(), removeAttribute: vi.fn(),
    querySelector: () => ({ textContent: "" }),
  }));
  const dialog = {
    open: true, dataset: { mode: "progress" }, querySelectorAll: () => steps,
    querySelector: (selector: string) => selector === "#prepElapsed" ? elapsed : { setAttribute: vi.fn() },
  };
  let progress: ReturnType<typeof createTranslationProgress> | undefined;
  try {
    progress = createTranslationProgress(dialog as unknown as HTMLDialogElement);
    const run = { startedAt: new Date().toISOString(), completedAt: null, state: "running", phase: "streaming", validationState: null } as AiRunView;
    progress.update(run, false, false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(900);
    progress.update({ ...run }, false, false);
    onMutation();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(steps[0]!.classList.toggle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(elapsed.textContent).toBe("00:01");
    expect(vi.getTimerCount()).toBe(1);
    documentState.hidden = true; listeners.get("visibilitychange")!();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2500);
    documentState.hidden = false; listeners.get("visibilitychange")!();
    expect(elapsed.textContent).toBe("00:03");
    dialog.open = false; onMutation();
    expect(vi.getTimerCount()).toBe(0);
    dialog.open = true; onMutation();
    expect(vi.getTimerCount()).toBe(1);
    progress.update({ ...run, state: "completed", phase: "completed", completedAt: new Date().toISOString() }, false, false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(elapsed.textContent).toBe("00:03");
    progress.dispose(); progress = undefined;
    expect(listeners.size).toBe(0);
  } finally {
    progress?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  }
});
