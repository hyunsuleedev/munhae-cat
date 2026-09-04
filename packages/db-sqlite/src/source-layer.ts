import {
  canonicalJsonHash,
  codepointCount,
  createId,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import type { ProjectActors } from "./bootstrap.ts";
import { insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";

export type SourceLayerResult = {
  sourceTextId: string;
  sourceVersionId: string;
  punctuationVersionId: string;
  anchorSetId: string;
};

function splitUnits(text: string): Array<{ text: string; kind: "sentence" | "paragraph" }> {
  const trimmed = text.replace(/^\uFEFF/, "");
  if (!trimmed) return [];
  const chunks = trimmed.split(/(?<=[。．！？!?\n])/u).filter((s) => s.length > 0);
  const units = (chunks.length ? chunks : [trimmed]).map((part) => {
    const t = part;
    const kind: "sentence" | "paragraph" = /[。．！？!?]\s*$/u.test(t) ? "sentence" : "paragraph";
    return { text: t, kind };
  });
  return units.filter((u) => u.text.trim().length > 0 || u.text.length > 0);
}

function anchorKey(i: number): string {
  return `A${String(i).padStart(3, "0")}`;
}

export function insertSourceLayer(opts: {
  db: SqliteDb;
  projectId: string;
  documentNodeId: string;
  name: string;
  text: string;
  originKind: "paste" | "manual" | "import";
  policyVersionId: string;
  actors: ProjectActors;
  now: string;
}): SourceLayerResult {
  const text = opts.text.replace(/^\uFEFF/, "");
  if (!text.trim()) {
    throw new Error("empty source");
  }
  const sourceTextId = createId();
  const sourceVersionId = createId();
  insertRow(opts.db, "src_texts", {
    id: sourceTextId,
    project_id: opts.projectId,
    document_node_id: opts.documentNodeId,
    name: opts.name,
    status: "active",
    created_at: opts.now,
    tombstoned_at: null,
  });
  insertRow(opts.db, "src_text_versions", {
    id: sourceVersionId,
    project_id: opts.projectId,
    source_text_id: sourceTextId,
    parent_version_id: null,
    version_no: 1,
    content_text: text,
    origin_kind: opts.originKind,
    source_asset_id: null,
    change_summary: null,
    state: "draft",
    content_hash: sha256Hex(text),
    created_by_actor_id: opts.actors.humanId,
    created_at: opts.now,
  });
  insertRow(opts.db, "src_text_heads", {
    project_id: opts.projectId,
    source_text_id: sourceTextId,
    current_version_id: sourceVersionId,
    confirmed_version_id: null,
    lock_version: 1,
    updated_at: opts.now,
  });

  const units = splitUnits(text);
  const setId = createId();
  const puncVersionId = createId();
  const spanManifest = units.map((u, i) => ({ spanKind: u.kind, ordinal: i + 1, quote: u.text }));
  const puncHash = canonicalJsonHash({ punctuatedText: text, spans: spanManifest });
  insertRow(opts.db, "punctuation_sets", {
    id: setId,
    project_id: opts.projectId,
    source_text_id: sourceTextId,
    name: `${opts.name} 표점`,
    policy_version_id: opts.policyVersionId,
    status: "active",
    created_at: opts.now,
  });
  insertRow(opts.db, "punctuation_versions", {
    id: puncVersionId,
    project_id: opts.projectId,
    punctuation_set_id: setId,
    source_text_version_id: sourceVersionId,
    parent_version_id: null,
    version_no: 1,
    punctuated_text: text,
    structure_json: JSON.stringify({ kind: "prose" }),
    change_summary: "원문 입력 시 자동 생성",
    state: "draft",
    content_hash: puncHash,
    created_by_actor_id: opts.actors.humanId,
    created_at: opts.now,
  });
  insertRow(opts.db, "punctuation_heads", {
    project_id: opts.projectId,
    punctuation_set_id: setId,
    current_version_id: puncVersionId,
    confirmed_version_id: null,
    lock_version: 1,
    updated_at: opts.now,
  });

  const fullLen = codepointCount(text);
  const paraId = createId();
  insertRow(opts.db, "punctuation_structure_spans", {
    id: paraId,
    project_id: opts.projectId,
    punctuation_version_id: puncVersionId,
    span_kind: "paragraph",
    parent_span_id: null,
    ordinal: 1,
    codepoint_from: 0,
    codepoint_to: fullLen,
    quote: text,
    quote_hash: sha256Hex(text),
    origin_kind: "rule",
    confidence: null,
    label: null,
    created_by_actor_id: opts.actors.humanId,
    created_at: opts.now,
  });

  let cursor = 0;
  const mapped: Array<{
    key: string;
    ordinal: number;
    kind: string;
    from: number;
    to: number;
    quote: string;
    spanId: string;
  }> = [];
  units.forEach((u, i) => {
    const from = cursor;
    const to = from + codepointCount(u.text);
    const spanId = createId();
    insertRow(opts.db, "punctuation_structure_spans", {
      id: spanId,
      project_id: opts.projectId,
      punctuation_version_id: puncVersionId,
      span_kind: u.kind === "sentence" ? "sentence" : "clause",
      parent_span_id: paraId,
      ordinal: i + 1,
      codepoint_from: from,
      codepoint_to: to,
      quote: u.text,
      quote_hash: sha256Hex(u.text),
      origin_kind: "rule",
      confidence: null,
      label: null,
      created_by_actor_id: opts.actors.humanId,
      created_at: opts.now,
    });
    mapped.push({
      key: anchorKey(i + 1),
      ordinal: i + 1,
      kind: u.kind === "sentence" ? "sentence" : "paragraph",
      from,
      to,
      quote: u.text,
      spanId,
    });
    cursor = to;
  });
  if (mapped.length === 0) {
    mapped.push({
      key: "A001",
      ordinal: 1,
      kind: "document",
      from: 0,
      to: fullLen,
      quote: text,
      spanId: paraId,
    });
  }

  const hash = canonicalJsonHash({
    sourceTextVersionId: sourceVersionId,
    punctuationVersionId: puncVersionId,
    strategyKey: "sentence-clause-v1",
    strategyVersion: 1,
    coveragePolicy: "full_text",
    anchors: mapped.map((a) => ({
      anchorKey: a.key,
      ordinal: a.ordinal,
      boundaryKind: a.kind,
      punctuationFrom: a.from,
      punctuationTo: a.to,
      punctuatedQuoteHash: sha256Hex(a.quote),
      sourceFrom: a.from,
      sourceTo: a.to,
      sourceQuoteHash: sha256Hex(sliceCodepoints(text, a.from, a.to)),
    })),
  });
  const anchorSetId = createId();
  insertRow(opts.db, "translation_anchor_sets", {
    id: anchorSetId,
    project_id: opts.projectId,
    document_node_id: opts.documentNodeId,
    source_text_version_id: sourceVersionId,
    punctuation_version_id: puncVersionId,
    strategy_key: "sentence-clause-v1",
    strategy_version: 1,
    coverage_policy: "full_text",
    anchor_set_hash: hash,
    created_by_actor_id: opts.actors.systemId,
    created_at: opts.now,
  });
  for (const a of mapped) {
    const id = createId();
    const sourceQuote = sliceCodepoints(text, a.from, a.to);
    insertRow(opts.db, "translation_anchors", {
      id,
      project_id: opts.projectId,
      anchor_set_id: anchorSetId,
      anchor_key: a.key,
      ordinal: a.ordinal,
      boundary_kind: a.kind,
      punctuation_codepoint_from: a.from,
      punctuation_codepoint_to: a.to,
      punctuated_quote: a.quote,
      punctuated_quote_hash: sha256Hex(a.quote),
      source_codepoint_from: a.from,
      source_codepoint_to: a.to,
      source_quote: sourceQuote,
      source_quote_hash: sha256Hex(sourceQuote),
      context_before_hash: null,
      context_after_hash: null,
      display_label: a.key,
      required: 1,
      created_at: opts.now,
    });
    insertRow(opts.db, "translation_anchor_structure_spans", {
      project_id: opts.projectId,
      anchor_id: id,
      punctuation_structure_span_id: a.spanId,
      ordinal: 1,
    });
    if (a.spanId !== paraId) {
      insertRow(opts.db, "translation_anchor_structure_spans", {
        project_id: opts.projectId,
        anchor_id: id,
        punctuation_structure_span_id: paraId,
        ordinal: 2,
      });
    }
  }

  return { sourceTextId, sourceVersionId, punctuationVersionId: puncVersionId, anchorSetId };
}
