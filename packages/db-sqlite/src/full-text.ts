import { matchUnchangedTextSentences, textSentences, type TextSentence } from "@munhae/domain/text-sentences";
export { textSentences, type TextSentence } from "@munhae/domain/text-sentences";
import {
  canonicalJson,
  createId,
  MunhaeError,
  nowIso,
  sha256Hex,
  codepointCount,
  sliceCodepoints,
} from "@munhae/domain";
import { BUNDLED_SKILLS } from "./bundled-skills.ts";
import { listReviewComments } from "./review-comments.ts";
import { allRows, getRow, insertRow } from "./rows.ts";
import {
  captureTranslationHead,
  storeTranslationResponse,
} from "./ai-ledger.ts";
import type { ProjectRepo } from "./project-repo.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { ProjectActors } from "./bootstrap.ts";
type Context = Pick<
  ProjectRepo,
  "getEditor" | "getHome" | "getKnowledge" | "projectId"
> & { db: SqliteDb; actors: ProjectActors; policyVersionId: string };
import type {
  ContextPreview,
  ContextPreviewInput,
  BeginTranslationRunInput,
  CompleteTranslationRunInput,
  ReviewCommentView,
  SaveSentenceLinkInput,
} from "./views.ts";

export type TextLink = {
  sentenceId: string;
  spans: Array<{ from: number; to: number; quote: string }>;
  needsReview: boolean;
  reviewedBy?: "human";
};
export type TextLayout = {
  state: "pending" | "running" | "ready" | "needs_review" | "failed";
  sentences: TextSentence[];
  links: TextLink[];
  error: string | null;
};

function hasUncoveredSource(source: string, links: TextLink[]): boolean {
  const covered = new Set<number>();
  for (const link of links)
    for (const span of link.spans)
      for (let i = span.from; i < span.to; i++) covered.add(i);
  return Array.from(source).some((ch, i) => !/[\p{P}\p{Z}\s]/u.test(ch) && !covered.has(i));
}

export type FullTextSnapshot = {
  documentNodeId: string;
  sourceTextId: string;
  sourceTextVersionId: string;
  punctuationVersionId: string | null;
  anchorSetId: string | null;
  policyVersionId: string;
  targetLocale: string;
  expectedHead: ReturnType<typeof captureTranslationHead>;
  revision?: {
    baseVersionId: string;
    baseTranslationHash: string;
    comments: ReviewCommentView[];
  };
};
const fail = (message: string): never => {
  throw new MunhaeError("invalid_submission", message);
};
const skill = (name: keyof typeof BUNDLED_SKILLS) => {
  const content = BUNDLED_SKILLS[name];
  if (!content?.includes("version: 1.0.0"))
    throw new MunhaeError(
      "skill_unavailable",
      "기본 번역 스킬을 읽지 못했습니다",
    );
  return { name, version: "1.0.0", hash: sha256Hex(content), content };
};
const translationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "translation"],
  properties: {
    schemaVersion: { const: 1 },
    translation: { type: "string", minLength: 1 },
  },
};
const toolInstruction = (command: string) =>
  `Submit one JSON object through stdin to "$MUNHAE_NODE_BIN" "$MUNHAE_BIN" tools ${command}. Use your shell with a quoted heredoc. These environment variables point to the app's submission wrapper. The user authorized this draft operation. Do not write project files. Assistant prose is not submission.`;

export function loadTextLayout(
  repo: Context,
  versionId: string,
): TextLayout | null {
  const row = getRow<{
    alignment_state: TextLayout["state"];
    sentences_json: string;
    links_json: string;
    alignment_error: string | null;
  }>(
    repo.db,
    "SELECT * FROM translation_text_layouts WHERE version_id=?",
    versionId,
  );
  return row
    ? {
        state: row.alignment_state,
        sentences: JSON.parse(row.sentences_json),
        links: JSON.parse(row.links_json),
        error: row.alignment_error,
      }
    : null;
}

export type FullTextPreview = Omit<ContextPreview, "snapshot"> & {
  snapshot: FullTextSnapshot;
};

export function previewText(
  repo: Context,
  input: ContextPreviewInput,
): FullTextPreview {
  const editor = repo.getEditor(input.documentNodeId);
  if (!editor.source.contentText.trim())
    throw new MunhaeError("not_ready", "저장된 원문이 필요합니다");
  const punc =
    editor.punctuation?.state === "confirmed" ? editor.punctuation : null;
  const policy = getRow<{
    id: string;
    target_locale: string;
    [key: string]: unknown;
  }>(
    repo.db,
    "SELECT * FROM core_translation_policy_versions WHERE id=?",
    repo.policyVersionId,
  )!;
  const sourceTextId = getRow<{ source_text_id: string }>(
    repo.db,
    "SELECT source_text_id FROM src_text_versions WHERE id=?",
    editor.source.versionId,
  )!.source_text_id;
  const snapshot: FullTextSnapshot = {
    documentNodeId: input.documentNodeId,
    sourceTextId,
    sourceTextVersionId: editor.source.versionId,
    punctuationVersionId: punc?.versionId ?? null,
    anchorSetId: punc?.anchorSetId ?? null,
    policyVersionId: policy.id,
    targetLocale: policy.target_locale,
    expectedHead: captureTranslationHead(
      repo.db,
      repo.projectId,
      sourceTextId,
      policy.target_locale,
    ),
  };
  const required: ContextPreview["required"] = [];
  const add = (
    kind: string,
    label: string,
    content: string,
    version?: string,
  ) =>
    required.push({
      kind,
      label,
      content,
      version,
      hash: sha256Hex(content),
      chars: codepointCount(content),
    });
  const method = skill("translate-document");
  add("translation_skill", "기본 번역 스킬", method.content, method.version);
  add(
    "source",
    "전체 원문",
    punc?.punctuatedText ?? editor.source.contentText,
    punc?.versionId ?? editor.source.versionId,
  );
  add("translation_policy", "번역 원칙", canonicalJson(policy), policy.id);
  add("document_metadata", "문서 정보", canonicalJson(editor.document));
  if (input.revision) {
    const { baseVersionId, commentIds } = input.revision;
    if (!editor.translation || editor.translation.versionId !== baseVersionId || !editor.translation.isCurrentDependencies)
      throw new MunhaeError("stale_request", "검토한 번역 또는 원문이 변경되었습니다. 현재 번역에서 코멘트를 확인하세요");
    if (!Array.isArray(commentIds) || commentIds.length === 0 || commentIds.length > 500
      || commentIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 80)
      || new Set(commentIds).size !== commentIds.length)
      fail("반영할 코멘트를 선택하세요");
    const available = new Map(listReviewComments(repo, input.documentNodeId).map((c) => [c.id, c]));
    const comments = commentIds.map((id) => {
      const c = available.get(id);
      if (!c || c.translationVersionId !== baseVersionId
        || c.targetVersionId !== (c.targetKind === "source" ? editor.source.versionId : baseVersionId))
        throw new MunhaeError("stale_request", "삭제되었거나 다른 번역에 작성한 코멘트가 포함되어 있습니다");
      return c;
    });
    snapshot.revision = { baseVersionId, baseTranslationHash: sha256Hex(editor.translation.textContent), comments };
    add("revision_instruction", "코멘트를 반영한 전문 재번역", [
      "원문, 이전 번역 전문, 아래에서 선택한 검토 코멘트를 함께 읽고 수정된 번역 전문을 제출하세요.",
      "코멘트는 인용 구절과 그 주변 문맥에 적용할 번역가의 검토 의견입니다. 판단이나 수정 지시는 반영하고, 질문과 불확실성은 확정 사실로 바꾸지 마세요.",
      "코멘트가 영향을 주는 주변 문장의 주체, 지시 대상, 어조도 함께 검토하세요. 수정이 필요 없는 내용과 원문의 정보는 보존하세요.",
      "일부 수정문이나 코멘트에 대한 답변만 제출하지 말고, 빠짐없는 전체 번역을 제출하세요.",
      "선택 범위는 각 targetVersionId의 0부터 시작하는 유니코드 코드포인트 반열림 구간입니다. source 범위는 표점 전 저장 원문을 기준으로 합니다.",
    ].join("\n"), "translation-revision.v1");
    add("base_translation", "검토한 이전 번역 전문", editor.translation.textContent, baseVersionId);
    add("review_comments", "반영할 검토 코멘트", canonicalJson(comments), baseVersionId);
  }
  add(
    "output_contract",
    "번역 전문 제출 형식",
    canonicalJson(translationSchema),
    "translation-text.v1",
  );
  const lineage = new Set<string>();
  const docs = repo.getHome().documents;
  let node: string | null = input.documentNodeId;
  while (node && !lineage.has(node)) {
    lineage.add(node);
    node = docs.find((d) => d.id === node)?.parentId ?? null;
  }
  const kn = repo.getKnowledge();
  const auxiliary: ContextPreview["auxiliary"] = [];
  const aux = (
    id: string,
    kind: string,
    label: string,
    content: string,
    defaultIncluded: boolean,
    reason: string,
  ) => {
    const selection =
      input.selections?.find((s) => s.id === id)?.mode ?? "auto";
    auxiliary.push({
      id,
      kind,
      label,
      content,
      defaultIncluded,
      reason,
      selection,
      included:
        selection === "pin" || (selection === "auto" && defaultIncluded),
      hash: sha256Hex(content),
      chars: codepointCount(content),
    });
  };
  for (const c of kn.contextItems
    .filter((c) => lineage.has(c.scopeId))
    .sort(
      (a, b) =>
        [...lineage].indexOf(a.scopeId) - [...lineage].indexOf(b.scopeId) ||
        b.priority - a.priority,
    ))
    aux(
      c.id,
      "context_item",
      c.title,
      c.contentMd,
      c.enabled,
      c.scopeId === input.documentNodeId
        ? "current_document_context"
        : "ancestor_document_context",
    );
  for (const g of kn.glossary)
    aux(
      g.id,
      "glossary",
      g.sourceTerm,
      canonicalJson(g),
      editor.source.contentText.includes(g.sourceTerm),
      "project_glossary",
    );
  for (const p of kn.persons)
    aux(
      p.id,
      "person",
      p.preferredName,
      canonicalJson(p),
      true,
      "project_person",
    );
  for (const p of kn.places)
    aux(
      p.id,
      "place",
      p.preferredName,
      canonicalJson(p),
      true,
      "project_place",
    );
  const relatedIds = new Set([
    ...lineage,
    editor.source.versionId,
    punc?.versionId,
    editor.translation?.versionId,
    ...allRows<{ id: string }>(
      repo.db,
      "SELECT a.id FROM translation_anchors a JOIN translation_anchor_sets s ON s.id=a.anchor_set_id WHERE s.document_node_id=?",
      input.documentNodeId,
    ).map((a) => a.id),
  ]);
  for (const u of kn.uncertainties.filter((u) => u.state === "open"))
    aux(
      u.id,
      "uncertainty",
      u.statementMd,
      canonicalJson(u),
      u.anchors.some((a) => relatedIds.has(a.targetVersionId)),
      "related_uncertainty",
    );
  const confirmed = allRows<{
    id: string;
    text_content: string;
    document_node_id: string;
    title: string;
  }>(
    repo.db,
    `SELECT v.id,v.text_content,t.document_node_id,n.title FROM document_translation_heads h JOIN document_translation_versions v ON v.id=h.confirmed_version_id JOIN document_translations t ON t.id=h.document_translation_id JOIN document_nodes n ON n.id=t.document_node_id WHERE t.project_id=? AND v.state='confirmed'`,
    repo.projectId,
  );
  for (const v of confirmed)
    aux(
      `confirmed-translation:${v.id}`,
      "confirmed_translation",
      `확정 번역 · ${v.title}`,
      v.text_content,
      v.document_node_id === input.documentNodeId,
      "confirmed_translation",
    );
  const requestText = [
    toolInstruction("submit-translation"),
    ...required.map((r) => `## ${r.label}\n${r.content}`),
    ...auxiliary
      .filter((a) => a.included)
      .map((a) => `## ${a.label}\n${a.content}`),
  ].join("\n\n");
  const requestHash = sha256Hex(requestText);
  const manifestJson = canonicalJson({
    flow: "full-text.v1",
    snapshot,
    requestHash,
    skills: [method, skill("align-translation")].map(({ content, ...s }) => s),
    sources: [...required, ...auxiliary.filter((a) => a.included)].map(
      ({ content, ...s }) => s,
    ),
  });
  return {
    characterCount: codepointCount(requestText),
    utf8ByteCount: Buffer.byteLength(requestText),
    manifestHash: sha256Hex(manifestJson),
    requestHash,
    requestText,
    promptContractVersion: "full-text.v1",
    required,
    auxiliary,
    status: "ready",
    manifestJson,
    snapshot,
  };
}

export function beginText(
  repo: Context,
  input: BeginTranslationRunInput & { alignmentVersionId?: string },
) {
  return repo.db.transaction(() => {
    if (input.alignmentVersionId && input.revision) fail("재번역과 원문 연결은 별도로 실행하세요");
    if (
      getRow(
        repo.db,
        `SELECT id FROM chat_messages WHERE project_id=? AND role='assistant' AND state IN ('running','validating') LIMIT 1`,
        repo.projectId,
      )
    )
      throw new MunhaeError("thread_busy", "AI 작업이 진행 중입니다");
    const preview = previewText(repo, input);
    if (input.alignmentVersionId) {
      const e = repo.getEditor(input.documentNodeId);
      if (
        e.translation?.versionId !== input.alignmentVersionId ||
        !e.translation.textLayout ||
        !e.translation.textContent.trim() ||
        !e.translation.isCurrentDependencies
      )
        throw new MunhaeError(
          "stale_request",
          "현재 번역의 연결만 실행할 수 있습니다",
        );
      preview.requestText = alignmentRequest(repo, input.alignmentVersionId);
      preview.requestHash = sha256Hex(preview.requestText);
      preview.utf8ByteCount = Buffer.byteLength(preview.requestText);
      preview.manifestJson = canonicalJson({
        flow: "alignment.v1",
        snapshot: preview.snapshot,
        versionId: input.alignmentVersionId,
        requestHash: preview.requestHash,
        skill: skill("align-translation"),
      });
      preview.manifestHash = sha256Hex(preview.manifestJson);
      preview.promptContractVersion = "alignment.v1";
    }
    const now = nowIso(),
      threadId = createId(),
      messageId = createId(),
      requestArtifactId = createId();
    insertRow(repo.db, "chat_threads", {
      id: threadId,
      project_id: repo.projectId,
      title: input.revision ? "코멘트 반영 전문 재번역" : "AI 전문 번역",
      scope_kind: "document_node",
      scope_id: input.documentNodeId,
      created_by_actor_id: repo.actors.humanId,
      created_at: now,
    });
    const existing = getRow<{ id: string }>(
      repo.db,
      "SELECT id FROM provenance_artifacts WHERE project_id=? AND artifact_kind='exact_llm_request' AND canonical_sha256=?",
      repo.projectId,
      preview.requestHash,
    );
    if (!existing)
      insertRow(repo.db, "provenance_artifacts", {
        id: requestArtifactId,
        project_id: repo.projectId,
        artifact_kind: "exact_llm_request",
        media_type: "text/plain",
        payload_text: preview.requestText,
        raw_sha256: preview.requestHash,
        canonical_sha256: preview.requestHash,
        byte_size: preview.utf8ByteCount,
        created_at: now,
      });
    insertRow(repo.db, "chat_messages", {
      id: messageId,
      project_id: repo.projectId,
      thread_id: threadId,
      role: "assistant",
      actor_id: repo.actors.llmId,
      state: "running",
      agent_id: input.agentId,
      requested_model: input.requestedModel,
      reasoning_level: input.reasoningLevel,
      service_tier: input.serviceTier,
      runtime_version: input.runtimeVersion,
      task_kind: "translation",
      output_contract: input.alignmentVersionId
        ? "translation-alignment.v1"
        : "translation-text.v1",
      prompt_contract_version: preview.promptContractVersion,
      request_manifest_json: preview.manifestJson,
      request_manifest_hash: preview.manifestHash,
      request_artifact_id: existing?.id ?? requestArtifactId,
      started_at: now,
      created_at: now,
    });
    return {
      messageId,
      threadId,
      requestArtifactId: existing?.id ?? requestArtifactId,
      ...preview,
    };
  })();
}

function insertTextVersion(
  repo: Context,
  s: FullTextSnapshot,
  text: string,
  origin: string,
  messageId: string | null,
  skills: string,
) {
  const current = captureTranslationHead(
    repo.db,
    repo.projectId,
    s.sourceTextId,
    s.targetLocale,
  );
  if (canonicalJson(current) !== canonicalJson(s.expectedHead))
    throw new MunhaeError(
      "cas_conflict",
      "번역안이 변경되어 결과를 적용하지 않았습니다",
    );
  const source = getRow<{ current_version_id: string }>(
    repo.db,
    "SELECT current_version_id FROM src_text_heads WHERE source_text_id=?",
    s.sourceTextId,
  );
  if (source?.current_version_id !== s.sourceTextVersionId)
    throw new MunhaeError("stale_request", "원문이 변경되었습니다");
  if (s.punctuationVersionId) {
    const p = getRow<{ current_version_id: string }>(
      repo.db,
      "SELECT h.current_version_id FROM punctuation_heads h JOIN punctuation_sets p ON p.id=h.punctuation_set_id WHERE p.source_text_id=?",
      s.sourceTextId,
    );
    if (p?.current_version_id !== s.punctuationVersionId)
      throw new MunhaeError("stale_request", "사용한 표점이 변경되었습니다");
  }
  const now = nowIso(),
    versionId = createId();
  const trans = getRow<{ id: string }>(
    repo.db,
    "SELECT id FROM document_translations WHERE project_id=? AND source_text_id=? AND target_locale=?",
    repo.projectId,
    s.sourceTextId,
    s.targetLocale,
  );
  const translationId = trans?.id ?? createId();
  if (!trans)
    insertRow(repo.db, "document_translations", {
      id: translationId,
      project_id: repo.projectId,
      document_node_id: s.documentNodeId,
      source_text_id: s.sourceTextId,
      target_locale: s.targetLocale,
      created_at: now,
    });
  const n = getRow<{ n: number }>(
    repo.db,
    "SELECT coalesce(max(version_no),0)+1 AS n FROM document_translation_versions WHERE document_translation_id=?",
    translationId,
  )!.n;
  insertRow(repo.db, "document_translation_versions", {
    id: versionId,
    project_id: repo.projectId,
    document_translation_id: translationId,
    parent_version_id: current?.currentVersionId ?? null,
    version_no: n,
    source_text_version_id: s.sourceTextVersionId,
    punctuation_version_id: s.punctuationVersionId,
    translation_anchor_set_id: s.anchorSetId,
    translation_policy_version_id: s.policyVersionId,
    text_content: text,
    origin_kind: origin,
    generated_by_message_id: messageId,
    validation_state: text.trim() ? "valid" : "needs_review",
    needs_review: text.trim() ? 0 : 1,
    state: "draft",
    content_hash: sha256Hex(text),
    created_by_actor_id:
      origin === "ai" ? repo.actors.llmId : repo.actors.humanId,
    created_at: now,
  });
  if (current)
    repo.db
      .prepare(
        "UPDATE document_translation_heads SET current_version_id=?,lock_version=lock_version+1,updated_at=? WHERE document_translation_id=? AND lock_version=?",
      )
      .run(versionId, now, translationId, current.lockVersion);
  else
    insertRow(repo.db, "document_translation_heads", {
      project_id: repo.projectId,
      document_translation_id: translationId,
      current_version_id: versionId,
      confirmed_version_id: null,
      lock_version: 1,
      updated_at: now,
    });
  insertRow(repo.db, "translation_text_layouts", {
    version_id: versionId,
    sentences_json: canonicalJson(textSentences(text)),
    skill_manifest_json: skills,
  });
  return { translationId, versionId, validationState: "valid" as const };
}

export function completeText(
  repo: Context,
  input: CompleteTranslationRunInput,
) {
  return repo.db.transaction(() => {
    const m = getRow<{ request_manifest_json: string }>(
      repo.db,
      "SELECT request_manifest_json FROM chat_messages WHERE id=? AND project_id=? AND task_kind='translation'",
      input.messageId,
      repo.projectId,
    );
    if (!m)
      throw new MunhaeError("invalid_message", "번역 실행을 찾을 수 없습니다");
    const manifest = JSON.parse(m.request_manifest_json) as {
      flow: string;
      snapshot: FullTextSnapshot;
      skills: unknown;
    };
    if (manifest.flow !== "full-text.v1") fail("다른 실행의 제출입니다");
    const payload = JSON.parse(input.rawResponse);
    if (
      !payload ||
      Array.isArray(payload) ||
      Object.keys(payload).some(
        (k) => !["schemaVersion", "translation"].includes(k),
      ) ||
      payload.schemaVersion !== 1 ||
      typeof payload.translation !== "string" ||
      !payload.translation.trim()
    )
      fail("번역 전문 형식이 올바르지 않습니다");
    storeTranslationResponse(repo.db, repo.projectId, input);
    const prior = getRow<{ id: string; document_translation_id: string }>(
      repo.db,
      "SELECT id,document_translation_id FROM document_translation_versions WHERE generated_by_message_id=?",
      input.messageId,
    );
    const version = prior
      ? {
          translationId: prior.document_translation_id,
          versionId: prior.id,
          validationState: "valid" as const,
        }
      : insertTextVersion(
          repo,
          manifest.snapshot,
          payload.translation,
          "ai",
          input.messageId,
          canonicalJson(manifest.skills),
        );
    repo.db
      .prepare(
        "UPDATE chat_messages SET state='completed',output_validation_state='valid',completed_at=? WHERE id=?",
      )
      .run(nowIso(), input.messageId);
    return {
      messageId: input.messageId,
      validationState: "valid" as const,
      fatalFindings: 0,
      recoverableFindings: 0,
      version,
      idempotent: !!prior,
    };
  })();
}

export function saveText(
  repo: Context,
  documentNodeId: string,
  text: string,
  lock: number,
) {
  if (!text.trim()) fail("번역 내용을 입력하세요");
  return repo.db.transaction(() => {
    const editor = repo.getEditor(documentNodeId);
    const previous = editor.translation;
    if (!previous?.isCurrentDependencies) throw new MunhaeError("stale_request", "원문이 변경되었습니다. 현재 원문 기준으로 새 번역안을 만드세요");
    const preview = previewText(repo, { documentNodeId });
    const s = preview.snapshot;
    if (s.expectedHead?.lockVersion !== lock)
      throw new MunhaeError("cas_conflict", "번역안이 변경되었습니다");
    const version = insertTextVersion(
      repo,
      s,
      text,
      "human",
      null,
      canonicalJson(
        [skill("translate-document"), skill("align-translation")].map(
          ({ content, ...s }) => s,
        ),
      ),
    );
    const previousLayout = previous.textLayout;
    if (previousLayout?.links.length) {
      const sentences = textSentences(text);
      // Reopening an unchanged confirmed version keeps even repeated sentences
      // at their exact positions. Edited text must never guess by T-number.
      const matches = text === previous.textContent
        ? new Map(sentences.map((sentence) => [sentence.id, sentence.id]))
        : matchUnchangedTextSentences(previousLayout.sentences, sentences);
      const previousLinks = new Map(previousLayout.links.map((link) => [link.sentenceId, link]));
      const links: TextLink[] = sentences.map((sentence) => {
        const previousId = matches.get(sentence.id);
        const link = previousId ? previousLinks.get(previousId) : undefined;
        return link
          ? { ...link, sentenceId: sentence.id }
          : { sentenceId: sentence.id, spans: [], needsReview: true };
      });
      const uncovered = hasUncoveredSource(editor.source.contentText, links);
      const needsReview = uncovered || previousLayout.state !== "ready" || links.some((link) => link.needsReview);
      repo.db.prepare(`UPDATE translation_text_layouts SET alignment_state=?, links_json=?, alignment_error=? WHERE version_id=?`)
        .run(needsReview ? "needs_review" : "ready", canonicalJson(links),
          uncovered ? "연결되지 않은 원문 범위가 있습니다" : needsReview ? previousLayout.error : null, version.versionId);
    }
    return version;
  })();
}

export function confirmText(
  repo: Context,
  documentNodeId: string,
  lock: number,
) {
  const e = repo.getEditor(documentNodeId);
  if (!e.translation?.textContent.trim()) fail("번역 내용을 입력하세요");
  if (!e.translation?.isCurrentDependencies)
    throw new MunhaeError("stale_request", "원문 또는 번역이 변경되었습니다");
  repo.db.transaction(() => {
    const h = getRow<{ document_translation_id: string; lock_version: number }>(
      repo.db,
      "SELECT * FROM document_translation_heads WHERE current_version_id=?",
      e.translation!.versionId,
    );
    if (h?.lock_version !== lock)
      throw new MunhaeError("cas_conflict", "번역안이 변경되었습니다");
    repo.db
      .prepare(
        "UPDATE document_translation_versions SET state='confirmed' WHERE id=?",
      )
      .run(e.translation!.versionId);
    repo.db
      .prepare(
        "UPDATE document_translation_heads SET confirmed_version_id=?,lock_version=lock_version+1 WHERE document_translation_id=?",
      )
      .run(e.translation!.versionId, h.document_translation_id);
  })();
}

export function saveSentenceLink(repo: Context, input: SaveSentenceLinkInput): void {
  repo.db.transaction(() => {
    const editor = repo.getEditor(input.documentNodeId);
    const translation = editor.translation;
    const layout = translation?.textLayout;
    if (!translation || !layout || translation.versionId !== input.versionId || !translation.isCurrentDependencies)
      throw new MunhaeError("stale_request", "원문 또는 번역이 변경되었습니다. 현재 문장에서 대응을 다시 확인하세요");
    if (!Number.isSafeInteger(input.expectedLockVersion) || input.expectedLockVersion < 1 || translation.lockVersion !== input.expectedLockVersion)
      throw new MunhaeError("cas_conflict", "번역안이 변경되었습니다. 다시 불러오세요");
    if (layout.state === "running")
      throw new MunhaeError("alignment_running", "자동 원문 연결이 끝난 뒤 대응을 수정하세요");
    if (!layout.sentences.some((sentence) => sentence.id === input.sentenceId)) fail("번역 문장을 찾을 수 없습니다");
    if (!Array.isArray(input.spans) || input.spans.length < 1 || input.spans.length > 100) fail("대응하는 원문 범위를 선택하세요");
    const spans = input.spans.map((span) => {
      if (!span || !Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to)
        || span.from < 0 || span.to <= span.from || span.to > 20_000_000 || span.to > codepointCount(editor.source.contentText)
        || typeof span.quote !== "string" || !span.quote.trim() || span.quote.length > 100_000
        || codepointCount(span.quote) !== span.to - span.from
        || sliceCodepoints(editor.source.contentText, span.from, span.to) !== span.quote)
        fail("선택한 원문 범위와 인용이 일치하지 않습니다");
      return { from: span.from, to: span.to, quote: span.quote };
    });
    const existing = new Map(layout.links.map((link) => [link.sentenceId, link]));
    const links: TextLink[] = layout.sentences.map((sentence) => sentence.id === input.sentenceId
      ? { sentenceId: sentence.id, spans, needsReview: false, reviewedBy: "human" }
      : existing.get(sentence.id) ?? { sentenceId: sentence.id, spans: [], needsReview: true });
    const uncovered = hasUncoveredSource(editor.source.contentText, links);
    const state = uncovered || links.some((link) => link.needsReview) ? "needs_review" : "ready";
    const changed = repo.db.prepare(`UPDATE document_translation_heads SET lock_version=lock_version+1, updated_at=? WHERE current_version_id=? AND lock_version=?`)
      .run(nowIso(), input.versionId, input.expectedLockVersion);
    if (changed.changes !== 1) throw new MunhaeError("cas_conflict", "번역안이 변경되었습니다. 다시 불러오세요");
    repo.db.prepare(`UPDATE translation_text_layouts SET links_json=?, alignment_state=?, alignment_error=? WHERE version_id=?`)
      .run(canonicalJson(links), state, uncovered ? "연결되지 않은 원문 범위가 있습니다" : null, input.versionId);
  })();
}

export function alignmentRequest(repo: Context, versionId: string) {
  const v = getRow<{ text_content: string; source_text_version_id: string }>(
    repo.db,
    "SELECT text_content,source_text_version_id FROM document_translation_versions WHERE id=? AND project_id=?",
    versionId,
    repo.projectId,
  );
  if (!v) throw new MunhaeError("not_found", "번역을 찾지 못했습니다");
  const source = getRow<{ content_text: string }>(
    repo.db,
    "SELECT content_text FROM src_text_versions WHERE id=?",
    v.source_text_version_id,
  )!.content_text;
  const layout = loadTextLayout(repo, versionId)!;
  const quoteSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text", "occurrence"],
    properties: {
      text: { type: "string" },
      occurrence: { type: "integer", minimum: 1 },
    },
  };
  const linkSchema = {
    type: "object",
    additionalProperties: false,
    required: ["sentenceId", "quotes", "needsReview"],
    properties: {
      sentenceId: { type: "string" },
      needsReview: { type: "boolean" },
      quotes: { type: "array", items: quoteSchema },
    },
  };
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "versionId", "links"],
    properties: {
      schemaVersion: { const: 1 },
      versionId: { const: versionId },
      links: { type: "array", items: linkSchema },
    },
  };
  const hints = allRows(
    repo.db,
    "SELECT a.punctuated_quote FROM translation_anchors a JOIN document_translation_versions v ON v.translation_anchor_set_id=a.anchor_set_id WHERE v.id=? ORDER BY a.ordinal",
    versionId,
  );
  const prompt = [
    skill("align-translation").content,
    toolInstruction("submit-alignment"),
    `## Source (exact quotes must come from this text)\n${source}`,
    `## Optional boundary hints\n${canonicalJson(hints)}`,
    `## Complete saved translation\n${v.text_content}`,
    `## Target sentences\n${canonicalJson(layout.sentences)}`,
    `## Schema\n${canonicalJson(schema)}`,
  ].join("\n\n");
  repo.db
    .prepare(
      "UPDATE translation_text_layouts SET alignment_state='running',alignment_request=?,alignment_error=NULL WHERE version_id=?",
    )
    .run(prompt, versionId);
  return prompt;
}

export function completeAlignment(
  repo: Context,
  versionId: string,
  raw: string,
) {
  return repo.db.transaction(() => {
    const v = getRow<{
      source_text_version_id: string;
      current_version_id: string;
      content_text: string;
    }>(
      repo.db,
      `SELECT v.source_text_version_id,h.current_version_id,s.content_text FROM document_translation_versions v JOIN document_translation_heads h ON h.document_translation_id=v.document_translation_id JOIN src_text_versions s ON s.id=v.source_text_version_id WHERE v.id=? AND v.project_id=?`,
      versionId,
      repo.projectId,
    );
    if (!v || v.current_version_id !== versionId)
      throw new MunhaeError(
        "stale_request",
        "번역이 수정되어 이전 내용의 연결을 적용하지 않았습니다",
      );
    const currentSource = getRow<{ current_version_id: string }>(
      repo.db,
      "SELECT h.current_version_id FROM src_text_heads h JOIN src_text_versions v ON v.source_text_id=h.source_text_id WHERE v.id=?",
      v.source_text_version_id,
    );
    if (currentSource?.current_version_id !== v.source_text_version_id)
      throw new MunhaeError(
        "stale_request",
        "원문이 변경되어 연결을 적용하지 않았습니다",
      );
    const p = JSON.parse(raw);
    if (
      !p ||
      p.schemaVersion !== 1 ||
      p.versionId !== versionId ||
      Object.keys(p).some(
        (k) => !["schemaVersion", "versionId", "links"].includes(k),
      ) ||
      !Array.isArray(p.links)
    )
      fail("연결 제출 형식이 올바르지 않습니다");
    const layout = loadTextLayout(repo, versionId)!;
    const seen = new Set<string>();
    const links: TextLink[] = p.links.map((l: any) => {
      if (
        !l ||
        Object.keys(l).some(
          (k) => !["sentenceId", "quotes", "needsReview"].includes(k),
        ) ||
        !layout.sentences.some((s) => s.id === l.sentenceId) ||
        seen.has(l.sentenceId) ||
        !Array.isArray(l.quotes) ||
        typeof l.needsReview !== "boolean"
      )
        fail("문장 연결 형식이 올바르지 않습니다");
      seen.add(l.sentenceId);
      const spans = l.quotes.map((q: any) => {
        if (
          !q ||
          Object.keys(q).some((k) => !["text", "occurrence"].includes(k)) ||
          typeof q.text !== "string" ||
          !q.text.trim() ||
          !Number.isInteger(q.occurrence) ||
          q.occurrence < 1
        )
          fail("원문 인용이 올바르지 않습니다");
        let at = -1;
        for (let i = 0; i < q.occurrence; i++) {
          at = v.content_text.indexOf(q.text, at + 1);
          if (at < 0) fail("원문에서 인용 위치를 찾을 수 없습니다");
        }
        const from = codepointCount(v.content_text.slice(0, at));
        return { from, to: from + codepointCount(q.text), quote: q.text };
      });
      // A rerun may fill missing links, but must not replace a human's correction.
      const reviewed = layout.links.find((link) => link.sentenceId === l.sentenceId && link.reviewedBy === "human");
      return reviewed ?? {
        sentenceId: l.sentenceId,
        spans,
        needsReview: l.needsReview || !spans.length,
      };
    });
    if (seen.size !== layout.sentences.length)
      fail("모든 번역 문장에 연결 또는 확인 필요 표시가 있어야 합니다");
    const uncovered = hasUncoveredSource(v.content_text, links);
    const state =
      uncovered || links.some((l) => l.needsReview) ? "needs_review" : "ready";
    repo.db
      .prepare(
        "UPDATE translation_text_layouts SET alignment_state=?,links_json=?,alignment_response=?,alignment_error=? WHERE version_id=?",
      )
      .run(
        state,
        canonicalJson(links),
        raw,
        uncovered ? "연결되지 않은 원문 범위가 있습니다" : null,
        versionId,
      );
    return state;
  })();
}
export function failAlignment(
  repo: Context,
  versionId: string,
  message: string,
) {
  repo.db
    .prepare(
      "UPDATE translation_text_layouts SET alignment_state='failed',alignment_error=? WHERE version_id=? AND alignment_state<>'ready'",
    )
    .run(message, versionId);
}

export function createTextDraft(
  repo: Context,
  documentNodeId: string,
  sourceLock: number,
  targetLock?: number,
) {
  return repo.db.transaction(() => {
    const e = repo.getEditor(documentNodeId);
    if (e.source.lockVersion !== sourceLock)
      throw new MunhaeError("cas_conflict", "원문이 변경되었습니다");
    if (e.translation && targetLock === undefined)
      throw new MunhaeError("already_exists", "번역안이 이미 있습니다");
    if (targetLock !== undefined && e.translation?.lockVersion !== targetLock)
      throw new MunhaeError("cas_conflict", "번역안이 변경되었습니다");
    const p = previewText(repo, { documentNodeId });
    return insertTextVersion(
      repo,
      p.snapshot,
      "",
      "human",
      null,
      canonicalJson(
        [skill("translate-document"), skill("align-translation")].map(
          ({ content, ...s }) => s,
        ),
      ),
    );
  })();
}

export function finishTextRun(
  repo: Context,
  input: CompleteTranslationRunInput,
) {
  storeTranslationResponse(repo.db, repo.projectId, input);
  repo.db
    .prepare(
      "UPDATE chat_messages SET state='completed',output_validation_state='valid',completed_at=? WHERE id=? AND project_id=?",
    )
    .run(nowIso(), input.messageId, repo.projectId);
}
