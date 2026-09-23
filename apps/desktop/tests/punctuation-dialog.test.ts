import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { t, ui } from "../src/renderer/scripts/i18n";

const source = readFileSync(new URL("../src/renderer/scripts/editor.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.Latest, true);
const names = ["openPunctuationPreparation", "renderPunctuationPreparationControls"];
const production = ts.transpileModule(names.map(name => {
  const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(name);
  return node.getText(ast);
}).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const elements = new Map<string, any>();
  const must = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, { textContent: "", value: "prose", hidden: false, open: false, showModal: vi.fn(function(this: { open: boolean }) { this.open = true; }) });
    return elements.get(selector);
  };
  const refresh = vi.fn(), settings = vi.fn(), start = vi.fn();
  const runner = new Function("must", "t", "ui", "refreshAgentProbes", "renderPunctuationPreparationSettings", "startPunctuationSuggestion", `
    let view = { document: { id: 'doc', title: '<source>', originalTitle: '' }, source: { contentText: '甲𥊑乙' } };
    let auxiliaryRun = null, auxiliaryStarting = null, punctuationSuggestion = null;
    let aiStarting = false, aiRun = null, agentProbeLoading = false, prepSettingsSaveError = null, prepSettingsPending = 0;
    const fmt = String, codepointLength = text => Array.from(text).length;
    const selectedPunctuationAgent = () => 'codex', agentReady = () => true;
    const activeAuxiliaryKind = () => auxiliaryRun?.state === 'running' ? auxiliaryRun.taskKind : auxiliaryStarting;
    const $$ = () => [];
    let punctuationProgressMode = false;
    const renderPunctuationProgress = (_run, _starting, running) => { if (running) punctuationProgressMode = true; };
    const renderAuxiliaryRunControls = () => renderPunctuationPreparationControls();
    ${production}
    return { open: openPunctuationPreparation, render: renderPunctuationPreparationControls,
      setRun: run => auxiliaryRun = run,
      setSuggestion: suggestion => punctuationSuggestion = suggestion,
      setSettingsError: error => prepSettingsSaveError = error };
  `)(must, t, ui, refresh, settings, start);
  return { runner, must, refresh, settings, start };
}

describe("punctuation preparation dialog", () => {
  it("opens a preparation surface without starting AI or rewriting the source", () => {
    const { runner, must, refresh, start } = harness();
    runner.open();
    expect(must("#dlgPunctuation").open).toBe(true);
    expect(must("#punctuationPrepTitle").textContent).toBe("<source>");
    expect(must("#punctuationPrepSource").textContent).toBe("甲𥊑乙");
    expect(must("#punctuationPrepSourceInfo").textContent).toBe("3자 · 산문");
    expect(refresh).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    runner.open();
    expect(must("#dlgPunctuation").showModal).toHaveBeenCalledOnce();
  });
  it("reopens a running task without dispatching it again and uses only the current document", () => {
    const { runner, must, start } = harness();
    runner.setRun({ taskKind: "punctuation_suggest", documentNodeId: "doc", state: "running", messageId: "run" });
    runner.open();
    expect(must("#punctuationPrepSpinner").hidden).toBe(false);
    expect(must("#punctuationPrepFootnote").textContent).toBe("닫아도 작업은 계속됩니다.");
    expect(start).not.toHaveBeenCalled();
    runner.setRun({ taskKind: "punctuation_suggest", documentNodeId: "other", state: "running" });
    runner.render();
    expect(must("#punctuationPrepSpinner").hidden).toBe(true);
  });
  it("offers review only for a validated unapplied result from the current run", () => {
    const { runner, must } = harness();
    runner.setRun({ taskKind: "punctuation_suggest", documentNodeId: "doc", state: "completed", messageId: "new" });
    runner.setSuggestion({ documentNodeId: "doc", validationState: "valid", applied: false, messageId: "old" });
    runner.render();
    expect(must("#punctuationPrepReview").hidden).toBe(true);
    runner.setSuggestion({ documentNodeId: "doc", validationState: "valid", applied: false, messageId: "new" });
    runner.render();
    expect(must("#punctuationPrepReview").hidden).toBe(false);
    runner.setSuggestion({ documentNodeId: "doc", validationState: "invalid", applied: false, messageId: "new" });
    runner.render();
    expect(must("#punctuationPrepReview").hidden).toBe(true);
  });
  it("surfaces settings persistence failure with a retry", () => {
    const { runner, must } = harness();
    runner.setSettingsError(new Error("offline"));
    runner.render();
    expect(must("#punctuationSettingsNote").hidden).toBe(false);
    expect(must("#punctuationRetrySettings").hidden).toBe(false);
  });
});
