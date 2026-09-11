import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";

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
  const receive = new Function("must", "loadEditor", "scheduleAiPoll", "clearAiPoll", "scheduleFinal", `
    let aiRun = null, aiStarting = false, aiCanceling = false, aiActionError = null;
    const view = { document: { id: 'doc' } };
    const handledAiTerminals = new Set(), finalizingAiTerminals = new Set(), translationShown = new Set();
    const hasUnsavedChanges = () => false, setWorkspace = () => {}, setView = () => {};
    const window = { setTimeout: scheduleFinal };
    const renderPreparationControls = () => renderAiRunPanel();
    ${ts.transpileModule(production, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
    return receiveAiRun;
  `)(must, loadEditor, poll, clearPoll, scheduleFinal);
  const run = { messageId: "run", documentNodeId: "doc", startedAt: "2026-09-10", state: "running", validationState: "valid" };
  for (const phase of ["streaming", "translation_saved", "aligning"]) {
    receive({ ...run, phase });
    await Promise.resolve();
    expect(must("#prepRunPanel").hidden).toBe(false);
    expect(must("#prepRunMeter").attributes["aria-busy"]).toBe("true");
    expect(must("#dlgPrepare").close).not.toHaveBeenCalled();
    if (phase !== "streaming") {
      expect(must("#prepRunState").textContent).toBe("문장을 연결하는 중");
      expect(must("#prepRunPhase").textContent).toBe("문장을 연결하는 중");
    }
  }
  expect(loadEditor).not.toHaveBeenCalled();
  expect(poll).toHaveBeenCalledTimes(3);
  expect(scheduleFinal).not.toHaveBeenCalled();
  receive({ ...run, state: "completed", phase: "completed" });
  expect(must("#prepRunMeter").attributes["aria-busy"]).toBe("false");
  expect(clearPoll).toHaveBeenCalledOnce();
  expect(scheduleFinal).toHaveBeenCalledOnce();
});
