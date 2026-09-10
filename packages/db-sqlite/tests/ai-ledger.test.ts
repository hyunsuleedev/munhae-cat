import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import { loadActors } from "../src/bootstrap.ts";
import {
  applyTranslationEnvelope,
  failTranslationRun,
  recordInvalidTranslationResponse,
  reserveTranslationRun,
  storeTranslationResponse,
} from "../src/ai-ledger.ts";
import { createProject, ProjectRepo, sqlitePath } from "../src/project-repo.ts";
import { openSqlite, type SqliteDb } from "../src/sqlite.ts";

const dirs: string[] = [];
const repos: ProjectRepo[] = [];
const databases: SqliteDb[] = [];

type ReadyEditor = ReturnType<ProjectRepo["getEditor"]> & {
  punctuation: NonNullable<ReturnType<ProjectRepo["getEditor"]>["punctuation"]> & { anchorSetId: string };
};

function readyEditor(editor: ReturnType<ProjectRepo["getEditor"]>): ReadyEditor {
  if (!editor.punctuation?.anchorSetId) throw new Error("test fixture requires confirmed punctuation anchors");
  return editor as ReadyEditor;
}

afterEach(() => {
  while (databases.length > 0) {
    try {
      databases.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (repos.length > 0) {
    try {
      repos.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-ai-ledger-"));
  dirs.push(parentDir);
  const created = createProject({ title: "AI ledger", parentDir });
  const repo = created.handle;
  repos.push(repo);
  const db = openSqlite(sqlitePath(repo.packagePath));
  databases.push(db);
  const policyVersion = db
    .prepare("SELECT current_version_id AS id FROM core_translation_policy_heads LIMIT 1")
    .get() as { id: string };
  const boot = {
    db,
    projectId: repo.projectId,
    actors: loadActors(db),
    policyVersionId: policyVersion.id,
  };
  const root = repo.getHome().documents.find((item) => item.isMaster)!;
  const document = repo.createDocument({
    title: "천자문",
    parentId: root.id,
    nodeRole: "source_unit",
    originKind: "paste",
    sourceText: "天地玄黃。宇宙洪荒。",
  });
  let editor = repo.getEditor(document.id);
  editor = repo.confirmSource({ documentNodeId: document.id, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({
    documentNodeId: document.id,
    structureMode: "prose",
    expectedSourceLockVersion: editor.source.lockVersion,
  });
  editor = repo.confirmPunctuation({
    documentNodeId: document.id,
    expectedLockVersion: editor.punctuation!.lockVersion,
  });
  return { boot, repo, document, editor: readyEditor(editor) };
}

function envelope(editor: ReadyEditor, mutate?: (body: Record<string, unknown>) => void): string {
  const body: Record<string, unknown> = {
    schemaVersion: 2,
    anchorSetId: editor.punctuation.anchorSetId,
    blocks: editor.anchors.map((anchor, index) => ({
      blockKey: `B${String(index + 1).padStart(3, "0")}`,
      sourceAnchorIds: [anchor.anchorKey],
      blockKind: anchor.boundaryKind,
      translation: `번역 ${index + 1}`,
    })),
  };
  mutate?.(body);
  return JSON.stringify(body);
}

function reserve(value: ReturnType<typeof setup>) {
  const preview = value.repo.previewLegacyContext({ documentNodeId: value.document.id });
  const run = reserveTranslationRun(value.boot.db, value.boot.projectId, value.boot.actors, {
    documentNodeId: value.document.id,
    documentTitle: value.document.title,
    agentId: "codex",
    requestedModel: "default",
    reasoningLevel: "medium",
    serviceTier: null,
    runtimeVersion: "codex-cli test",
    requestManifestJson: preview.manifestJson,
    requestText: preview.requestText,
    promptContractVersion: preview.promptContractVersion,
  });
  return { preview, run };
}

function storedApply(value: ReturnType<typeof setup>, rawResponse: string) {
  const prepared = reserve(value);
  storeTranslationResponse(value.boot.db, value.boot.projectId, {
    messageId: prepared.run.messageId,
    rawResponse,
    eventsJsonl: '{"type":"thread.completed"}\n',
    usage: { input_tokens: 10, output_tokens: 20 },
    resolvedModel: "gpt-test",
    runtimeVersion: "codex-cli test",
  });
  const applied = applyTranslationEnvelope(value.boot.db, value.boot.projectId, value.boot.actors, {
    messageId: prepared.run.messageId,
    documentNodeId: value.document.id,
    anchorSetId: prepared.preview.snapshot.anchorSetId,
    sourceTextVersionId: prepared.preview.snapshot.sourceTextVersionId,
    punctuationVersionId: prepared.preview.snapshot.punctuationVersionId,
    policyVersionId: prepared.preview.snapshot.policyVersionId,
    expectedHead: prepared.preview.snapshot.expectedHead,
    rawResponse,
  });
  return { ...prepared, applied };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected MunhaeError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(MunhaeError);
    expect((error as MunhaeError).code).toBe(code);
  }
}

describe("single AI translation ledger", () => {
  it("preserves a runtime-rejected provider result without a translation mutation", () => {
    const value = setup();
    const prepared = reserve(value);
    const raw = "printed JSON instead of submit_translation";
    const stored = recordInvalidTranslationResponse(value.boot.db, value.boot.projectId, {
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: '{"type":"status","phase":"completed"}\n',
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
      error: { code: "required_tool_not_called", message: "submit_translation was not called" },
    });

    expect(value.boot.db.prepare(
      "SELECT state, output_validation_state FROM chat_messages WHERE id = ?",
    ).get(prepared.run.messageId)).toEqual({ state: "completed", output_validation_state: "invalid_unapplied" });
    expect(value.boot.db.prepare("SELECT payload_text FROM provenance_artifacts WHERE id = ?")
      .get(stored.responseArtifactId)).toEqual({ payload_text: raw });
    expect(value.boot.db.prepare(
      "SELECT COUNT(*) AS n FROM document_translation_versions WHERE generated_by_message_id = ?",
    ).get(prepared.run.messageId)).toEqual({ n: 0 });
  });

  it("applies one valid v2 envelope to the translation aggregate and is byte-idempotent", () => {
    const value = setup();
    const raw = envelope(value.editor);
    const result = storedApply(value, raw);

    expect(result.applied.validation.state).toBe("valid");
    expect(result.applied.version).toMatchObject({ validationState: "valid" });
    expect(value.repo.getEditor(value.document.id).translation).toMatchObject({
      versionId: result.applied.version!.versionId,
      isCurrentDependencies: true,
      validationState: "valid",
      originKind: "ai",
    });
    expect(value.boot.db.prepare(
      "SELECT target_locale FROM document_translations WHERE id = ?",
    ).get(result.applied.version!.translationId)).toEqual({ target_locale: "ko" });

    const retried = applyTranslationEnvelope(value.boot.db, value.boot.projectId, value.boot.actors, {
      messageId: result.run.messageId,
      documentNodeId: value.document.id,
      anchorSetId: result.preview.snapshot.anchorSetId,
      sourceTextVersionId: result.preview.snapshot.sourceTextVersionId,
      punctuationVersionId: result.preview.snapshot.punctuationVersionId,
      policyVersionId: result.preview.snapshot.policyVersionId,
      expectedHead: result.preview.snapshot.expectedHead,
      rawResponse: raw,
    });
    expect(retried.idempotent).toBe(true);
    expect(retried.version?.versionId).toBe(result.applied.version?.versionId);
  });

  it("commits through ProjectRepo before returning and idempotently enriches same-response metadata", () => {
    const value = setup();
    const prepared = reserve(value);
    const raw = envelope(value.editor);
    const earlyEvents = '{"type":"tool_call","state":"started"}\n';
    const finalEvents = `${earlyEvents}{"type":"tool_call","state":"completed"}\n`;

    const first = value.repo.completeTranslationRun({
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: earlyEvents,
      usage: null,
      resolvedModel: null,
      runtimeVersion: null,
    });

    expect(first.validationState).toBe("valid");
    expect(first.idempotent).toBe(false);
    expect(value.repo.getEditor(value.document.id).translation?.versionId).toBe(first.version?.versionId);

    const second = value.repo.completeTranslationRun({
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: finalEvents,
      usage: { input_tokens: 12, output_tokens: 34 },
      resolvedModel: "gpt-final",
      runtimeVersion: "codex-cli test",
    });
    const third = value.repo.completeTranslationRun({
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: finalEvents,
      usage: { input_tokens: 12, output_tokens: 34 },
      resolvedModel: "gpt-final",
      runtimeVersion: "codex-cli test",
    });

    expect(second).toMatchObject({ idempotent: true, validationState: "valid" });
    expect(third).toMatchObject({ idempotent: true, validationState: "valid" });
    expect(second.version?.versionId).toBe(first.version?.versionId);
    expect(third.version?.versionId).toBe(first.version?.versionId);
    const message = value.boot.db.prepare(
      `SELECT events_artifact_id, usage_json, resolved_model, runtime_version
       FROM chat_messages WHERE id = ?`,
    ).get(prepared.run.messageId) as {
      events_artifact_id: string;
      usage_json: string;
      resolved_model: string;
      runtime_version: string;
    };
    expect(JSON.parse(message.usage_json)).toEqual({ input_tokens: 12, output_tokens: 34 });
    expect(message.resolved_model).toBe("gpt-final");
    expect(message.runtime_version).toBe("codex-cli test");
    expect(value.boot.db.prepare(
      "SELECT payload_text FROM provenance_artifacts WHERE id = ?",
    ).get(message.events_artifact_id)).toEqual({ payload_text: finalEvents });
    expect(value.boot.db.prepare(
      "SELECT COUNT(*) AS n FROM document_translation_versions WHERE generated_by_message_id = ?",
    ).get(prepared.run.messageId)).toEqual({ n: 1 });
  });

  it("enriches same-response evidence without overwriting a terminal stale/CAS failure", () => {
    const value = setup();
    const prepared = reserve(value);
    const raw = envelope(value.editor);
    const earlyEvents = '{"type":"tool_call","state":"started"}\n';
    const finalEvents = `${earlyEvents}{"type":"tool_call","state":"failed"}\n`;
    storeTranslationResponse(value.boot.db, value.boot.projectId, {
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: earlyEvents,
      usage: null,
      resolvedModel: null,
      runtimeVersion: "codex-cli test",
    });
    failTranslationRun(value.boot.db, value.boot.projectId, prepared.run.messageId, {
      code: "stale_request",
      message: "snapshot changed",
    });

    recordInvalidTranslationResponse(value.boot.db, value.boot.projectId, {
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: finalEvents,
      usage: { inputTokens: 7, outputTokens: 8 },
      resolvedModel: "gpt-final",
      runtimeVersion: "codex-cli test",
      error: { code: "submission_rejected", message: "generic rejection" },
    });

    const message = value.boot.db.prepare(
      `SELECT state, error_json, events_artifact_id, usage_json, resolved_model
       FROM chat_messages WHERE id = ?`,
    ).get(prepared.run.messageId) as {
      state: string;
      error_json: string;
      events_artifact_id: string;
      usage_json: string;
      resolved_model: string;
    };
    expect(message.state).toBe("failed");
    expect(JSON.parse(message.error_json)).toEqual({ code: "stale_request", message: "snapshot changed" });
    expect(JSON.parse(message.usage_json)).toEqual({ inputTokens: 7, outputTokens: 8 });
    expect(message.resolved_model).toBe("gpt-final");
    expect(value.boot.db.prepare(
      "SELECT payload_text FROM provenance_artifacts WHERE id = ?",
    ).get(message.events_artifact_id)).toEqual({ payload_text: finalEvents });
    expect(value.boot.db.prepare(
      "SELECT COUNT(*) AS n FROM document_translation_versions WHERE generated_by_message_id = ?",
    ).get(prepared.run.messageId)).toEqual({ n: 0 });
  });

  it.each([
    ["empty translation", (body: Record<string, unknown>) => {
      const blocks = body.blocks as Array<{ translation: string }>;
      blocks[0]!.translation = "";
    }],
    ["empty anchor link", (body: Record<string, unknown>) => {
      const blocks = body.blocks as Array<{ sourceAnchorIds: string[] }>;
      blocks[0]!.sourceAnchorIds = [];
    }],
    ["unknown anchor", (body: Record<string, unknown>) => {
      const blocks = body.blocks as Array<{ sourceAnchorIds: string[] }>;
      blocks[0]!.sourceAnchorIds = ["UNKNOWN"];
    }],
    ["same-block duplicate anchor", (body: Record<string, unknown>) => {
      const blocks = body.blocks as Array<{ sourceAnchorIds: string[] }>;
      blocks[0]!.sourceAnchorIds.push(blocks[0]!.sourceAnchorIds[0]!);
    }],
  ])("keeps %s as invalid_unapplied raw evidence and does not create a head", (_name, mutate) => {
    const value = setup();
    const raw = envelope(value.editor, mutate);
    const result = storedApply(value, raw);
    expect(result.applied.validation.state).toBe("invalid_unapplied");
    expect(result.applied.version).toBeNull();
    expect(value.repo.getEditor(value.document.id).translation).toBeNull();
    expect(value.boot.db.prepare(
      "SELECT COUNT(*) AS n FROM document_translation_versions WHERE generated_by_message_id = ?",
    ).get(result.run.messageId)).toEqual({ n: 0 });
    expect(value.boot.db.prepare(
      "SELECT state, output_validation_state, response_artifact_id FROM chat_messages WHERE id = ?",
    ).get(result.run.messageId)).toMatchObject({
      state: "completed",
      output_validation_state: "invalid_unapplied",
    });
  });

  it("applies an AI-authored mapping that omits a supplied anchor", () => {
    const value = setup();
    expect(value.editor.anchors.length).toBeGreaterThan(1);
    const raw = envelope(value.editor, (body) => {
      const blocks = body.blocks as Array<{ sourceAnchorIds: string[] }>;
      blocks.pop();
    });
    const result = storedApply(value, raw);

    expect(result.applied.validation).toMatchObject({
      state: "valid",
      fatalFindings: [],
      recoverableFindings: [],
    });
    expect(result.applied.version).toMatchObject({ validationState: "valid" });
    const saved = value.repo.getEditor(value.document.id).translation;
    expect(saved?.blocks).toHaveLength(value.editor.anchors.length - 1);
    expect(saved?.blocks.flatMap((block) => block.sourceAnchorIds)).not.toContain(
      value.editor.anchors.at(-1)?.anchorKey,
    );
  });

  it("preserves the same anchor when AI maps it to multiple blocks", () => {
    const value = setup();
    expect(value.editor.anchors.length).toBeGreaterThan(1);
    const reusedAnchor = value.editor.anchors[0]!.anchorKey;
    const raw = envelope(value.editor, (body) => {
      const blocks = body.blocks as Array<{ sourceAnchorIds: string[] }>;
      blocks[1]!.sourceAnchorIds.unshift(reusedAnchor);
    });
    const result = storedApply(value, raw);

    expect(result.applied.validation).toMatchObject({
      state: "valid",
      fatalFindings: [],
      recoverableFindings: [],
    });
    const saved = value.repo.getEditor(value.document.id).translation;
    expect(saved?.blocks[0]?.sourceAnchorIds).toEqual([reusedAnchor]);
    expect(saved?.blocks[1]?.sourceAnchorIds).toEqual([
      reusedAnchor,
      value.editor.anchors[1]!.anchorKey,
    ]);
    expect(saved?.blocks[0]?.relationKinds).toEqual(["partial"]);
    expect(saved?.blocks[1]?.relationKinds).toEqual(["partial", "full"]);
  });

  it("applies AI-selected block order", () => {
    const value = setup();
    expect(value.editor.anchors.length).toBeGreaterThan(1);
    const raw = envelope(value.editor, (body) => {
      const blocks = body.blocks as Array<{ sourceAnchorIds: string[] }>;
      blocks.reverse();
    });
    const result = storedApply(value, raw);
    expect(result.applied.validation).toMatchObject({
      state: "valid",
      fatalFindings: [],
      recoverableFindings: [],
    });
    expect(result.applied.version).toMatchObject({ validationState: "valid" });
  });

  it("rejects a valid result when the single aggregate head changed after request reservation", () => {
    const value = setup();
    const prepared = reserve(value);
    const created = value.repo.createTranslationDraft({
      documentNodeId: value.document.id,
      expectedSourceLockVersion: value.editor.source.lockVersion,
      expectedPunctuationLockVersion: value.editor.punctuation.lockVersion,
    });
    expect(created.translation).not.toBeNull();
    const raw = envelope(value.editor);
    storeTranslationResponse(value.boot.db, value.boot.projectId, {
      messageId: prepared.run.messageId,
      rawResponse: raw,
      eventsJsonl: "",
      usage: null,
      resolvedModel: null,
      runtimeVersion: null,
    });
    expectCode(() => applyTranslationEnvelope(value.boot.db, value.boot.projectId, value.boot.actors, {
      messageId: prepared.run.messageId,
      documentNodeId: value.document.id,
      anchorSetId: prepared.preview.snapshot.anchorSetId,
      sourceTextVersionId: prepared.preview.snapshot.sourceTextVersionId,
      punctuationVersionId: prepared.preview.snapshot.punctuationVersionId,
      policyVersionId: prepared.preview.snapshot.policyVersionId,
      expectedHead: prepared.preview.snapshot.expectedHead,
      rawResponse: raw,
    }), "cas_conflict");
  });

  it("uses the clean policy fields without adding an app-directed recipe", () => {
    const value = setup();
    value.boot.db.prepare(
      `UPDATE core_translation_policy_versions
       SET style_guide_md = '현대 한국어 문장으로 자연스럽게 옮긴다.',
           rules_json = '{"customRule":"고유명사는 원문 표기를 병기한다."}'
       WHERE id = ?`,
    ).run(value.boot.policyVersionId);
    const preview = value.repo.previewLegacyContext({ documentNodeId: value.document.id });
    expect(preview.requestText).toContain("tools submit-translation");
    expect(preview.requestText).toContain("현대 한국어 문장으로 자연스럽게 옮긴다.");
    expect(preview.requestText).toContain("고유명사는 원문 표기를 병기한다.");
    expect(preview.requestText).toContain("중요 용어는 한국어(漢字)로 병기한다.");
    expect(value.boot.db.prepare(
      "SELECT style_guide_md, rules_json FROM core_translation_policy_versions WHERE id = ?",
    ).get(value.boot.policyVersionId)).toEqual({
      style_guide_md: "현대 한국어 문장으로 자연스럽게 옮긴다.",
      rules_json: '{"customRule":"고유명사는 원문 표기를 병기한다."}',
    });
    expect(preview.manifestJson).not.toContain("recipe");
    expect(preview.manifestJson).not.toContain("expectedCandidates");
  });
});
