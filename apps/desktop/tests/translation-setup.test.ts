import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { parseAppConfig } from "../src/main/app-config";
import type { AgentProbe } from "../src/shared/munhae-api";
import { changePrepModelSetting, prepModelMarkup, prepAlignmentSummary, prepRequiredContent, isTechnicalPreparationItem } from "../src/renderer/scripts/translation-setup-ui";

const requiredItem = (kind: string, content: string, version?: string) => ({ kind, content, version, label: kind, hash: "hash", chars: content.length });

it("presents translation rules and document metadata without exposing database fields or changing their values", () => {
  const policy = requiredItem("translation_policy", JSON.stringify({
    id: "private-policy-id", content_hash: "internal-hash", audience: "연구자",
    style_guide_md: "줄바꿈을\n보존한다.", hanja_policy: "중요 용어(漢字)",
    rules_json: JSON.stringify({ supplementPolicy: "<보충>을 표시한다.", uncertaintyPolicy: "판단 유보" }),
  }));
  const original = policy.content;
  expect(prepRequiredContent(policy).fields).toEqual([
    { label: "대상 독자", value: "연구자" }, { label: "문체와 표현", value: "줄바꿈을\n보존한다." },
    { label: "한자 표기", value: "중요 용어(漢字)" }, { label: "보충 설명", value: "<보충>을 표시한다." },
    { label: "불확실성 처리", value: "판단 유보" },
  ]);
  expect(policy.content).toBe(original);
  expect(prepRequiredContent(requiredItem("document_metadata", JSON.stringify({ id: "internal", title: "장검행", authorName: null, originalTitle: null, language: "lzh" }))).fields).toEqual([
    { label: "제목", value: "장검행" }, { label: "원문 언어", value: "한문" },
  ]);
});

it("preserves source glyphs and review quotations while keeping the agent protocol in technical details", () => {
  const source = "謚 諡 {원문}\n祇恐祖生先著鞭。";
  expect(prepRequiredContent(requiredItem("source", source))).toEqual({ text: source });
  expect(prepRequiredContent(requiredItem("target_language", "Internal instruction", "en"))).toEqual({ text: "영어" });
  for (const kind of ["translation_skill", "output_contract"]) expect(isTechnicalPreparationItem(requiredItem(kind, "{}"))).toBe(true);
  expect(isTechnicalPreparationItem(requiredItem("translation_policy", "{}"))).toBe(false);
  const comments = JSON.stringify([{ id: "internal", targetKind: "source", quote: "捕取等嬰兒", bodyMd: "等의 의미를 확인" }]);
  expect(prepRequiredContent(requiredItem("reference_comments", "과거 사례입니다.\n" + comments))).toEqual({ text: "과거 사례입니다.", fields: [
    { label: "원문 구절", value: "捕取等嬰兒" }, { label: "검토 의견", value: "等의 의미를 확인" },
  ] });
  expect(prepRequiredContent(requiredItem("translation_policy", "{broken"))).toEqual({ text: "내용은 전송 상세에서 확인할 수 있습니다." });
});

const probe = {
  agentId: "codex", installed: true,
  capabilities: { modelSelection: true, reasoningEffort: true, serviceTier: true },
  models: [{ id: "first", label: "First", reasoningOptions: [{ id: "max", label: "Max" }], serviceTierOptions: [{ id: "priority", label: "Fast" }] },
    { id: "second", label: "Second", reasoningOptions: [{ id: "low", label: "Low" }], serviceTierOptions: [] }],
  reasoningOptions: [], serviceTierOptions: [],
} as unknown as AgentProbe;

it("changes only the selected provider and clears model-specific options that no longer apply", () => {
  const config = parseAppConfig({ agentModels: { codex: { model: "first", reasoning: "max", serviceTier: "priority" } } });
  const untouched = { ...config.agentModels.claude };
  expect(changePrepModelSetting(config, probe, "codex", "model", "second")).toBe(true);
  expect(config.agentModels.codex).toEqual({ model: "second", reasoning: null, serviceTier: null });
  expect(config.agentModels.claude).toEqual(untouched);
  expect(changePrepModelSetting(config, probe, "codex", "reasoning", "low")).toBe(true);
  expect(changePrepModelSetting(config, probe, "codex", "reasoning", "max")).toBe(false);
  expect(changePrepModelSetting(config, probe, "codex", "model", "unknown")).toBe(false);
});

it("keeps Gemini variant effort fixed and respects unavailable provider capabilities", () => {
  const config = parseAppConfig({});
  const gemini = { ...probe, agentId: "antigravity" as const, models: [{ id: "gemini-test-low", label: "Gemini Low" }] };
  expect(changePrepModelSetting(config, gemini, "antigravity", "model", "gemini-test-low")).toBe(true);
  expect(config.agentModels.antigravity.reasoning).toBe("low");
  expect(changePrepModelSetting(config, gemini, "antigravity", "reasoning", "max")).toBe(false);
  expect(prepModelMarkup(config, gemini, "antigravity")).toContain('data-prep-model-setting="reasoning" data-capability-disabled="true" disabled');
  expect(changePrepModelSetting(config, { ...probe, installed: false }, "codex", "model", "first")).toBe(false);
});

it("preserves escaped saved models in the menu and summarizes alignment inheritance", () => {
  const config = parseAppConfig({ agentModels: { codex: { model: '<custom"model>', reasoning: null, serviceTier: null } } });
  const html = prepModelMarkup(config, probe, "codex");
  expect(html).toContain('&lt;custom&quot;model&gt;');
  expect(html).not.toContain('<custom"model>');
  expect(prepAlignmentSummary(config, [probe])).toBe("번역 설정과 동일");
  config.alignment = { agentId: "codex", model: "second", reasoning: "low", serviceTier: null };
  expect(prepAlignmentSummary(config, [probe])).toBe("Codex · Second · low");
});

it("serializes settings snapshots, blocks execution after a failed save and permits retry", async () => {
  const source = readFileSync(new URL("../src/renderer/scripts/editor.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "queuePreparationSettingsSave")!;
  const production = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const config = parseAppConfig({});
  const save = vi.fn().mockResolvedValue(undefined);
  const harness = new Function("appConfig", "save", `
    let prepSettingsSaveChain = Promise.resolve(), prepSettingsSaveError = null, prepSettingsPending = 0;
    const api = { app: { setConfig: save } }, renderPreparationControls = () => {}, renderChatModelInfo = () => {}, renderAuxiliaryRunControls = () => {};
    ${production}
    return { queue: queuePreparationSettingsSave, wait: () => prepSettingsSaveChain, state: () => ({ pending: prepSettingsPending, error: prepSettingsSaveError }) };
  `)(config, save);
  config.agentModels.codex.model = "first"; harness.queue();
  config.agentModels.codex.model = "second"; harness.queue();
  expect(harness.state().pending).toBe(2);
  await harness.wait();
  expect(save.mock.calls.map(([patch]) => patch.agentModels.codex.model)).toEqual(["first", "second"]);
  expect(harness.state()).toEqual({ pending: 0, error: null });
  save.mockRejectedValueOnce(new Error("disk unavailable"));
  harness.queue(); await harness.wait();
  expect(harness.state().error.message).toBe("disk unavailable");
  harness.queue(); await harness.wait();
  expect(harness.state()).toEqual({ pending: 0, error: null });
});

function previewHarness() {
  const source = readFileSync(new URL("../src/renderer/scripts/editor.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("editor.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "loadPreparation")!;
  const production = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const requests: Array<{ resolve: (result: unknown) => void; reject: (error: Error) => void }> = [];
  const preview = vi.fn(() => new Promise((resolve, reject) => requests.push({ resolve, reject })));
  const loading = vi.fn(), render = vi.fn();
  const initial = { auxiliary: [{ id: "ref", selection: "auto" }], requestHash: "original" };
  const harness = new Function("preview", "loading", "render", "initial", `
    let prepPreview = initial, prepDocId = 'doc', prepRequest = 0, prepPreviewPending = false, prepPreviewError = null;
    const view = { document: { id: 'doc' } }, prepRevision = undefined;
    const prepAuxMode = new Map([['ref', 'auto']]);
    const api = { context: { preview } }, documentMaterials = { referenceCommentIds: () => [] };
    const renderPreparationControls = () => {}, renderPreparation = render, showPreparationLoading = () => { loading(); prepPreview = null; };
    const t = text => text, actionableAiError = error => error.message, notify = () => {}, must = () => ({});
    ${production}
    return { load: loadPreparation, select: mode => prepAuxMode.set('ref', mode), state: () => ({ preview: prepPreview, pending: prepPreviewPending, error: prepPreviewError, mode: prepAuxMode.get('ref') }) };
  `)(preview, loading, render, initial);
  return { harness, requests, loading, render, initial };
}

it("keeps the current preview mounted during selection refresh and ignores out-of-order replies", async () => {
  const { harness, requests, loading, render, initial } = previewHarness();
  harness.select("exclude"); const first = harness.load(true);
  expect(harness.state()).toMatchObject({ preview: initial, pending: true });
  expect(loading).not.toHaveBeenCalled();
  harness.select("pin"); const latest = harness.load(true);
  const next = { auxiliary: [{ id: "ref", selection: "pin" }], requestHash: "pinned" };
  requests[1]!.resolve({ ok: true, data: next }); await latest;
  requests[0]!.resolve({ ok: true, data: { auxiliary: [{ id: "ref", selection: "exclude" }], requestHash: "excluded" } }); await first;
  expect(harness.state()).toEqual({ preview: next, pending: false, error: null, mode: "pin" });
  expect(render).toHaveBeenCalledExactlyOnceWith(true);
});

it("keeps the preview on refresh failure, marks it unusable for launch and recovers on retry", async () => {
  const { harness, requests, loading, initial } = previewHarness();
  const failed = harness.load(true);
  requests[0]!.reject(new Error("preview unavailable")); await failed;
  expect(harness.state()).toMatchObject({ preview: initial, pending: false, error: "preview unavailable" });
  expect(loading).not.toHaveBeenCalled();
  const retry = harness.load(true);
  requests[1]!.resolve({ ok: true, data: initial }); await retry;
  expect(harness.state()).toMatchObject({ pending: false, error: null });
});
