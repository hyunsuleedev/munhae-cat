import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { replaceTextSentence, textSentences } from "@munhae/domain/text-sentences";

// Execute the production functions without booting the full renderer or a real
// project. This specifically exercises the lock path used by async IPC actions.
const source = readFileSync(new URL("../src/renderer/scripts/editor.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.Latest, true);
function functions(names: string[]) {
  const declarations = names.map((name) => {
    const node = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    if (!node) throw new Error(`Missing production function ${name}`);
    return node.getText(ast);
  });
  return ts.transpileModule(declarations.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

function harness() {
  const elements = new Map<string, any>();
  const must = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, {
      dataset: {}, textContent: "저장", value: "작성 중인 내용", disabled: false,
      readOnly: false, contentEditable: "true", setAttribute() {}, removeAttribute() {},
    });
    return elements.get(selector);
  };
  const current = { document: { id: "doc-1" }, source: { state: "draft" }, punctuation: { state: "draft" }, translation: { isCurrentDependencies: true, state: "draft" } };
  const notify = vi.fn();
  const api = new Function("must", "$$", "notify", "initial", `
    let view = initial, workspaceSaving = false, translationSaving = false, sourceEditingConfirmed = false;
    const activeMutations = new Map();
    const sentenceLinkUi = { isBusy: () => false }, reviewComments = { isSelecting: () => false };
    const previewedPunctuationSuggestion = () => null;
    const updateDraftActionDisabled = () => {}, renderComparisonState = () => {}, renderSaveState = () => {};
    const unwrap = result => result.ok ? result.data : null;
    ${functions(["editing", "editorMutationBusy", "renderEditingLocks", "setActionBusy", "actionResultIsCurrent", "runEditorViewAction"])}
    return { run: runEditorViewAction, render: renderEditingLocks, busy: editorMutationBusy,
      setDocument: id => { view = { ...view, document: { id } }; } };
  `)(must, (selector: string) => [must(selector)], notify, current);
  return { api, must, notify, current };
}

it("keeps every text entry locked when the draft UI rerenders during a delayed IPC mutation", async () => {
  const { api, must, current } = harness();
  let finish!: (value: unknown) => void;
  const pending = api.run("#confirm", "확정", () => new Promise((resolve) => { finish = resolve; }));
  api.render();
  expect(api.busy()).toBe(true);
  for (const selector of ["#sourceDraftText", "#punctuationDraftText", "#fullTranslationInput", "#rows .sentence-edit"])
    expect(must(selector).readOnly).toBe(true);
  for (const selector of ["#sourceOrigin", "#sourceChangeSummary", "#punctuationMode", "#punctuationChangeSummary"])
    expect(must(selector).disabled).toBe(true);
  expect(must("#rows .tgt-edit").contentEditable).toBe("false");
  const second = vi.fn();
  expect(await api.run("#other", "저장", second)).toBeNull();
  expect(second).not.toHaveBeenCalled();
  finish({ ok: true, data: current });
  expect(await pending).toBe(current);
  expect(api.busy()).toBe(false);
  expect(must("#sourceDraftText").readOnly).toBe(false);
  expect(must("#punctuationMode").disabled).toBe(false);
  expect(must("#rows .tgt-edit").contentEditable).toBe("true");
});

it("restores editing after failure and ignores an IPC response for a document that is no longer open", async () => {
  const { api, must, current, notify } = harness();
  expect(await api.run("#confirm", "확정", () => Promise.reject(new Error("연결 실패")))).toBeNull();
  expect(notify).toHaveBeenCalledWith("연결 실패", "확정");
  expect(must("#sourceDraftText").value).toBe("작성 중인 내용");
  expect(must("#sourceDraftText").readOnly).toBe(false);
  let finish!: (value: unknown) => void;
  const pending = api.run("#confirm", "확정", () => new Promise((resolve) => { finish = resolve; }));
  api.setDocument("doc-2");
  finish({ ok: true, data: current });
  expect(await pending).toBeNull();
  expect(api.busy()).toBe(false);
});

it("edits later sentences against canonical CRLF ranges instead of a textarea's normalized display", () => {
  const raw = "첫 𠀀 문장.\r\n\r\n둘째 문장.\r\n셋째 문장.";
  const editor = new Function("replaceTextSentence", "raw", "sentences", `
    let translationDraftText = raw, sentenceDrafts = sentences;
    ${functions(["updateSentenceDraft"])}
    return { edit: updateSentenceDraft, text: () => translationDraftText };
  `)(replaceTextSentence, raw, textSentences(raw));
  editor.edit("T3", "고친 𠮷 셋째 문장.");
  expect(editor.text()).toBe("첫 𠀀 문장.\r\n\r\n둘째 문장.\r\n고친 𠮷 셋째 문장.");
  editor.edit("T2", "고친 둘째 문장.");
  expect(editor.text()).toBe("첫 𠀀 문장.\r\n\r\n고친 둘째 문장.\r\n고친 𠮷 셋째 문장.");
});
