import {
  blockTargetRanges,
  canonicalJsonHash,
  createId,
  joinBlockTranslations,
  MunhaeError,
  nowIso,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import { allRows, getRow, insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { TranslationBlockView } from "./views.ts";

export type BlockDraft = {
  blockKey: string;
  blockKind: string;
  translation: string;
  sourceAnchorIds: string[];
  relationKinds?: string[];
};

export type AnchorRow = {
  id: string;
  anchor_key: string;
  ordinal: number;
  required: number;
  boundary_kind: string;
};

export type TranslationHeadRow = {
  document_translation_id: string;
  current_version_id: string;
  confirmed_version_id: string | null;
  lock_version: number;
};

export type TranslationVersionRow = {
  id: string;
  version_no: number;
  state: "draft" | "confirmed" | "rejected" | "superseded";
  validation_state: "valid" | "needs_review";
  text_content: string;
  origin_kind: string;
  parent_version_id: string | null;
  source_text_version_id: string;
  punctuation_version_id: string;
  translation_anchor_set_id: string;
  translation_policy_version_id: string;
};

export function casUpdateHead(
  db: SqliteDb,
  translationId: string,
  expectedLock: number,
  patch: { currentVersionId: string; confirmedVersionId?: string | null },
): void {
  const now = nowIso();
  const info = db
    .prepare(
      `UPDATE document_translation_heads
       SET current_version_id = @current,
           confirmed_version_id = CASE WHEN @setConfirmed = 1 THEN @confirmed ELSE confirmed_version_id END,
           lock_version = lock_version + 1,
           updated_at = @now
       WHERE document_translation_id = @id AND lock_version = @lock`,
    )
    .run({
      current: patch.currentVersionId,
      confirmed: patch.confirmedVersionId ?? null,
      setConfirmed: patch.confirmedVersionId !== undefined ? 1 : 0,
      now,
      id: translationId,
      lock: expectedLock,
    });
  if (info.changes !== 1) {
    throw new MunhaeError("cas_conflict", "stale lock_version");
  }
}

export function loadBlocks(db: SqliteDb, versionId: string): TranslationBlockView[] {
  const blocks = allRows<{
    id: string;
    block_key: string;
    ordinal: number;
    block_kind: string;
    target_codepoint_from: number;
    target_codepoint_to: number;
  }>(
    db,
    `SELECT id, block_key, ordinal, block_kind, target_codepoint_from, target_codepoint_to
     FROM translation_blocks
     WHERE document_translation_version_id = ?
     ORDER BY ordinal`,
    versionId,
  );
  const textRow = getRow<{ text_content: string }>(
    db,
    `SELECT text_content FROM document_translation_versions WHERE id = ?`,
    versionId,
  );
  const text = textRow?.text_content ?? "";
  const links = allRows<{
    translation_block_id: string;
    anchor_key: string;
    relation_kind: string;
    ordinal: number;
  }>(
    db,
    `SELECT tba.translation_block_id, a.anchor_key, tba.relation_kind, tba.ordinal
     FROM translation_block_anchors tba
     JOIN translation_anchors a ON a.id = tba.translation_anchor_id
     JOIN translation_blocks b ON b.id = tba.translation_block_id
     WHERE b.document_translation_version_id = ?
     ORDER BY tba.ordinal`,
    versionId,
  );
  const byBlock = new Map<string, { keys: string[]; kinds: string[] }>();
  for (const link of links) {
    const cur = byBlock.get(link.translation_block_id) ?? { keys: [], kinds: [] };
    cur.keys.push(link.anchor_key);
    cur.kinds.push(link.relation_kind);
    byBlock.set(link.translation_block_id, cur);
  }
  return blocks.map((b) => {
    const linked = byBlock.get(b.id) ?? { keys: [], kinds: [] };
    return {
      blockKey: b.block_key,
      ordinal: b.ordinal,
      blockKind: b.block_kind,
      translation: sliceCodepoints(text, b.target_codepoint_from, b.target_codepoint_to),
      sourceAnchorIds: linked.keys,
      relationKinds: linked.kinds,
    };
  });
}

export function validateBlocks(
  blocks: BlockDraft[],
  anchors: AnchorRow[],
): { findings: string[]; validationState: "valid" | "needs_review" } {
  const findings: string[] = [];
  const byKey = new Map(anchors.map((a) => [a.anchor_key, a]));
  const keys = new Set<string>();

  if (blocks.length === 0) findings.push("empty_block");
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!b) continue;
    if (keys.has(b.blockKey)) findings.push("duplicate_block_key");
    keys.add(b.blockKey);
    if (!b.translation.trim()) findings.push("empty_translation");
    const ids = b.sourceAnchorIds;
    if (ids.length === 0) findings.push("empty_block");
    const blockSeen = new Set<string>();
    for (const k of ids) {
      if (!byKey.has(k)) {
        findings.push("unknown_anchor");
      }
      if (blockSeen.has(k)) findings.push("duplicate_anchor");
      blockSeen.add(k);
    }
  }

  const unique = [...new Set(findings)];
  return {
    findings: unique,
    validationState: unique.length === 0 ? "valid" : "needs_review",
  };
}

function inferRelation(blocks: BlockDraft[], key: string): string {
  let n = 0;
  for (const b of blocks) {
    if (b.sourceAnchorIds.includes(key)) n += 1;
  }
  return n > 1 ? "partial" : "full";
}

export function insertVersionBlocks(
  db: SqliteDb,
  projectId: string,
  versionId: string,
  blocks: BlockDraft[],
  anchors: AnchorRow[],
  validationState: "valid" | "needs_review",
): { text: string; contentHash: string } {
  const translations = blocks.map((b) => b.translation);
  const text = joinBlockTranslations(translations);
  const ranges = blockTargetRanges(translations);
  const byKey = new Map(anchors.map((a) => [a.anchor_key, a]));

  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    const range = ranges[i] ?? { from: 0, to: 0 };
    if (!b) continue;
    const blockId = createId();
    const slice = sliceCodepoints(text, range.from, range.to);
    insertRow(db, "translation_blocks", {
      id: blockId,
      project_id: projectId,
      document_translation_version_id: versionId,
      block_key: b.blockKey,
      ordinal: i + 1,
      block_kind: b.blockKind,
      target_codepoint_from: range.from,
      target_codepoint_to: range.to,
      target_hash: sha256Hex(slice),
      validation_state: validationState,
    });
    let ord = 1;
    for (let j = 0; j < b.sourceAnchorIds.length; j += 1) {
      const key = b.sourceAnchorIds[j];
      if (!key) continue;
      const anchor = byKey.get(key);
      if (!anchor) continue;
      const relation = b.relationKinds?.[j] ?? inferRelation(blocks, key);
      insertRow(db, "translation_block_anchors", {
        project_id: projectId,
        translation_block_id: blockId,
        translation_anchor_id: anchor.id,
        ordinal: ord,
        relation_kind: relation,
        confidence: null,
      });
      ord += 1;
    }
  }

  return { text, contentHash: sha256Hex(text) };
}

export function recordValidation(
  db: SqliteDb,
  projectId: string,
  versionId: string,
  findings: string[],
  validationState: "valid" | "needs_review",
): void {
  const id = createId();
  insertRow(db, "document_translation_validations", {
    id,
    project_id: projectId,
    document_translation_version_id: versionId,
    source_message_id: null,
    validator_version: "m0-block-v1",
    result: validationState,
    needs_review: validationState === "needs_review" ? 1 : 0,
    summary_json: JSON.stringify({ findings }),
    validated_at: nowIso(),
  });
  for (const kind of findings) {
    insertRow(db, "document_translation_validation_findings", {
      id: createId(),
      project_id: projectId,
      validation_id: id,
      finding_kind: kind,
      severity: "warning",
      block_key: null,
      anchor_id: null,
      details_json: null,
    });
  }
}

export function loadAnchors(db: SqliteDb, anchorSetId: string): AnchorRow[] {
  return allRows<AnchorRow>(
    db,
    `SELECT id, anchor_key, ordinal, required, boundary_kind
     FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal`,
    anchorSetId,
  );
}

export { canonicalJsonHash };
