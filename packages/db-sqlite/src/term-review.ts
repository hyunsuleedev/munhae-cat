import { createId, nowIso, MunhaeError } from "@munhae/domain";
import type { SqliteDb } from "./sqlite.ts";

// A term is one sense of one written form. A document uses it only through its own
// confirmed link on a confirmed punctuation version; spelling alone never applies it.
export const TERM_KINDS = ["person", "place", "period", "event", "object", "work", "concept", "allusion", "grammar", "idu"] as const;
export type TermKind = typeof TERM_KINDS[number];
export type TermEvidence = { citation: string; url: string | null };
export type TermContent = {
  sourceForm: string; kind: TermKind; reading: string | null; translation: string | null;
  definition: string | null; evidence: TermEvidence[];
};
/** How sure this document's judgment is, as in translation footnotes. A person checks uses that are not certain or have alternatives. */
export const TERM_CONFIDENCE = ["certain", "probable", "unknown"] as const;
export type TermConfidence = typeof TERM_CONFIDENCE[number];
export const MAX_TERM_ALTERNATIVES = 3;
export type DocumentTermNotes = { contextNote: string | null; confidence: TermConfidence; alternatives: string[] };
/** Unicode code point range in the confirmed punctuated text. */
export type TermRange = { from: number; to: number };
export type TermGeneration = { runId: string; agentId: string; model: string };
export type ProjectTerm = TermContent & { id: string; lockVersion: number; createdAt: string; updatedAt: string };
/** A punctuated sentence holding a term, with the term's places in it counted from the sentence start. */
export type TermSentence = { text: string; marks: TermRange[] };
/** One document's sentences for a term: the first few unless all were asked for, and how many there are. */
export type TermSentencePage = { sentences: TermSentence[]; total: number };
/** One document's confirmed use of a term. `current` is false once the document's punctuation is re-confirmed. */
export type ProjectTermUse = { id: string; title: string; occurrences: number; contextNote: string | null; versionNo: number; current: boolean };
export type ProjectTermListItem = ProjectTerm & { documents: ProjectTermUse[] };
export type DocumentTerm = DocumentTermNotes & {
  id: string; documentId: string; punctuationVersionId: string; term: ProjectTerm;
  origin: "manual" | "ai"; generation: TermGeneration | null; occurrences: TermRange[];
  lockVersion: number; createdAt: string; updatedAt: string;
};
export type TermCandidate = TermContent & DocumentTermNotes & {
  id: string; documentId: string; punctuationVersionId: string; generation: TermGeneration;
  suggestedTermId: string | null; occurrences: TermRange[]; createdAt: string;
};
export type TermBasis = { documentId: string; punctuationVersionId: string; versionNo: number; text: string; sentences: TermRange[] };
export type DocumentTermsView = { basis: TermBasis | null; terms: DocumentTerm[]; candidates: TermCandidate[]; previousCount: number };
export type ConfirmTermInput = DocumentTermNotes & {
  documentId: string; punctuationVersionId: string; candidateId?: string | null;
  termId?: string | null; term?: TermContent; occurrences: TermRange[];
};
export type UpdateTermInput = Omit<TermContent, "sourceForm"> & { id: string; expectedLockVersion: number };
export type UpdateDocumentTermInput = DocumentTermNotes & { id: string; expectedLockVersion: number; occurrences?: TermRange[] };
export type TermCandidateInput = TermContent & DocumentTermNotes & { suggestedTermId: string | null; occurrences: TermRange[] };

const invalid = (message: string): never => { throw new MunhaeError("invalid_input", message); };

function text(value: unknown, label: string, max: number, required = false): string | null {
  if ((value == null || value === "") && !required) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) return invalid(`용어의 ${label} 값을 확인하세요.`);
  return value.trim();
}

export function validateTermContent(value: unknown): TermContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("용어 형식을 확인하세요.");
  const v = value as Record<string, unknown>;
  if (!TERM_KINDS.includes(v.kind as TermKind)) invalid("용어 분류를 확인하세요.");
  if (!Array.isArray(v.evidence) || v.evidence.length > 20) invalid("용어 근거를 확인하세요.");
  const evidence = (v.evidence as unknown[]).map(item => {
    const r = item as Record<string, unknown> | null;
    if (!r || typeof r.citation !== "string" || !r.citation.trim() || r.citation.length > 4000
      || (r.url != null && (typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || r.url.length > 4000))) invalid("근거의 설명과 주소를 확인하세요.");
    return { citation: (r!.citation as string).trim(), url: (r!.url as string | null | undefined) ?? null };
  });
  return {
    sourceForm: text(v.sourceForm, "원문 표현", 300, true)!, kind: v.kind as TermKind,
    reading: text(v.reading, "독음", 300), translation: text(v.translation, "번역어", 1000),
    definition: text(v.definition, "뜻풀이", 5000), evidence,
  };
}

function confidence(value: unknown): TermConfidence {
  if (value == null) return "certain";
  return TERM_CONFIDENCE.includes(value as TermConfidence) ? value as TermConfidence : invalid("용어의 확신 정도를 확인하세요.");
}

function alternatives(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_TERM_ALTERNATIVES) return invalid(`다른 해석은 ${MAX_TERM_ALTERNATIVES}개까지 적을 수 있습니다.`);
  return value.map(item => text(item, "다른 해석", 300)).filter((item): item is string => item !== null);
}

export function validateTermNotes(value: unknown): DocumentTermNotes {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    contextNote: text(v.contextNote, "이 글에서의 풀이", 5000),
    confidence: confidence(v.confidence),
    alternatives: alternatives(v.alternatives),
  };
}

function validateRanges(value: unknown, min = 1): TermRange[] {
  if (!Array.isArray(value) || value.length < min || value.length > 500) return invalid("용어의 등장 위치를 확인하세요.");
  const ranges = value.map(item => {
    const r = item as Record<string, unknown> | null;
    if (!r || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || (r.from as number) < 0 || (r.to as number) <= (r.from as number)) invalid("용어의 등장 위치를 확인하세요.");
    return { from: r!.from as number, to: r!.to as number };
  });
  if (new Set(ranges.map(r => `${r.from}:${r.to}`)).size !== ranges.length) invalid("같은 등장 위치가 중복되었습니다.");
  return ranges.sort((a, b) => a.from - b.from);
}

/** Every range must hold exactly the term's written form in the basis text. */
function assertRanges(basis: TermBasis, form: string, ranges: TermRange[]): void {
  const points = Array.from(basis.text);
  for (const range of ranges) {
    if (range.to > points.length || points.slice(range.from, range.to).join("") !== form) invalid(`‘${form}’의 등장 위치가 표점본과 일치하지 않습니다.`);
  }
}

/** Positions of a form inside the given 1-based sentence numbers of the basis. */
export function formPositions(basis: TermBasis, form: string, sentenceNumbers: number[]): TermRange[] {
  const points = Array.from(basis.text), glyphs = Array.from(form), found = new Map<number, TermRange>();
  for (const number of sentenceNumbers) {
    const sentence = basis.sentences[number - 1];
    if (!Number.isSafeInteger(number) || !sentence || !glyphs.length) continue;
    for (let at = sentence.from; at + glyphs.length <= sentence.to; at++) {
      if (glyphs.every((glyph, i) => points[at + i] === glyph)) found.set(at, { from: at, to: at + glyphs.length });
    }
  }
  return [...found.values()].sort((a, b) => a.from - b.from);
}

type BasisRow = { id: string; version_no: number; punctuated_text: string; source_text_version_id: string; source_current: string };

function basisRow(db: SqliteDb, projectId: string, documentId: string): BasisRow | null {
  const row = db.prepare(`SELECT pv.id, pv.version_no, pv.punctuated_text, pv.source_text_version_id, sh.current_version_id AS source_current
    FROM src_texts st
    JOIN punctuation_sets ps ON ps.source_text_id = st.id AND ps.status = 'active'
    JOIN punctuation_heads ph ON ph.punctuation_set_id = ps.id
    JOIN punctuation_versions pv ON pv.id = ph.confirmed_version_id
    JOIN src_text_heads sh ON sh.source_text_id = st.id
    WHERE st.document_node_id = ? AND st.project_id = ? AND st.tombstoned_at IS NULL
    ORDER BY ps.created_at LIMIT 1`).get(documentId, projectId) as BasisRow | undefined;
  return row && row.source_text_version_id === row.source_current ? row : null;
}

/** A basis with the span id of each of its sentences, which stored positions keep. */
type LoadedBasis = { basis: TermBasis; sentenceIds: string[] };

function loadBasis(db: SqliteDb, projectId: string, documentId: string): LoadedBasis | null {
  const row = basisRow(db, projectId, documentId);
  if (!row) return null;
  const spans = db.prepare(`SELECT id, codepoint_from AS "from", codepoint_to AS "to" FROM punctuation_structure_spans
    WHERE punctuation_version_id = ? AND span_kind IN ('sentence', 'verse_line') ORDER BY codepoint_from, codepoint_to`).all(row.id) as Array<TermRange & { id: string }>;
  const length = Array.from(row.punctuated_text).length;
  return {
    basis: { documentId, punctuationVersionId: row.id, versionNo: row.version_no, text: row.punctuated_text,
      sentences: spans.length ? spans.map(({ from, to }) => ({ from, to })) : length ? [{ from: 0, to: length }] : [] },
    sentenceIds: spans.map(span => span.id),
  };
}

/** The confirmed punctuation of the current source text; terms have no other basis. */
export function termBasis(db: SqliteDb, projectId: string, documentId: string): TermBasis | null {
  return loadBasis(db, projectId, documentId)?.basis ?? null;
}

function requireLoadedBasis(db: SqliteDb, projectId: string, documentId: string, versionId?: string): LoadedBasis {
  const loaded = loadBasis(db, projectId, documentId);
  if (!loaded) throw new MunhaeError("not_ready", "확정된 표점본이 있어야 용어를 다룰 수 있습니다.");
  if (versionId !== undefined && loaded.basis.punctuationVersionId !== versionId) throw new MunhaeError("conflict", "표점본이 다시 확정되었습니다. 용어 화면을 새로고침하세요.");
  return loaded;
}

function requireBasis(db: SqliteDb, projectId: string, documentId: string, versionId?: string): TermBasis {
  return requireLoadedBasis(db, projectId, documentId, versionId).basis;
}

type TermRow = { id: string; source_form: string; kind: TermKind; reading: string | null; translation: string | null; definition: string | null; evidence_json: string; lock_version: number; created_at: string; updated_at: string };
const termFromRow = (r: TermRow): ProjectTerm => ({ id: r.id, sourceForm: r.source_form, kind: r.kind, reading: r.reading, translation: r.translation,
  definition: r.definition, evidence: JSON.parse(r.evidence_json) as TermEvidence[], lockVersion: r.lock_version, createdAt: r.created_at, updatedAt: r.updated_at });

function getTerm(db: SqliteDb, projectId: string, id: string): ProjectTerm | null {
  const row = db.prepare("SELECT * FROM terms WHERE id = ? AND project_id = ?").get(id, projectId) as TermRow | undefined;
  return row ? termFromRow(row) : null;
}

type LinkRow = { id: string; document_node_id: string; term_id: string; punctuation_version_id: string; context_note: string | null; confidence: TermConfidence; alternatives_json: string; origin: "manual" | "ai"; generation_json: string | null; lock_version: number; created_at: string; updated_at: string };

function linksFromRows(db: SqliteDb, projectId: string, rows: LinkRow[]): DocumentTerm[] {
  if (!rows.length) return [];
  const occurrences = db.prepare("SELECT codepoint_from AS \"from\", codepoint_to AS \"to\" FROM term_occurrences WHERE document_term_id = ? ORDER BY codepoint_from");
  const terms = new Map<string, ProjectTerm>();
  return rows.map(r => {
    const term = terms.get(r.term_id) ?? getTerm(db, projectId, r.term_id)!;
    terms.set(r.term_id, term);
    return { id: r.id, documentId: r.document_node_id, punctuationVersionId: r.punctuation_version_id, term,
      contextNote: r.context_note, confidence: r.confidence, alternatives: JSON.parse(r.alternatives_json) as string[], origin: r.origin,
      generation: r.generation_json ? JSON.parse(r.generation_json) as TermGeneration : null,
      occurrences: occurrences.all(r.id) as TermRange[], lockVersion: r.lock_version, createdAt: r.created_at, updatedAt: r.updated_at };
  });
}

/** Links confirmed on one punctuation version, in order of first occurrence. */
function versionLinks(db: SqliteDb, projectId: string, versionId: string): DocumentTerm[] {
  const rows = db.prepare("SELECT * FROM document_terms WHERE project_id = ? AND punctuation_version_id = ? ORDER BY created_at, id").all(projectId, versionId) as LinkRow[];
  return linksFromRows(db, projectId, rows).sort((a, b) => (a.occurrences[0]?.from ?? 0) - (b.occurrences[0]?.from ?? 0));
}

function getLink(db: SqliteDb, projectId: string, id: string): DocumentTerm | null {
  const row = db.prepare("SELECT * FROM document_terms WHERE id = ? AND project_id = ?").get(id, projectId) as LinkRow | undefined;
  return row ? linksFromRows(db, projectId, [row])[0]! : null;
}

type CandidateRow = { id: string; document_node_id: string; punctuation_version_id: string; run_id: string; agent_id: string; model: string; suggested_term_id: string | null; source_form: string; kind: TermKind; reading: string | null; translation: string | null; definition: string | null; evidence_json: string; context_note: string | null; confidence: TermConfidence; alternatives_json: string; positions_json: string; created_at: string };
const candidateFromRow = (r: CandidateRow): TermCandidate => ({ id: r.id, documentId: r.document_node_id, punctuationVersionId: r.punctuation_version_id,
  generation: { runId: r.run_id, agentId: r.agent_id, model: r.model }, suggestedTermId: r.suggested_term_id,
  sourceForm: r.source_form, kind: r.kind, reading: r.reading, translation: r.translation, definition: r.definition,
  evidence: JSON.parse(r.evidence_json) as TermEvidence[], contextNote: r.context_note, confidence: r.confidence,
  alternatives: JSON.parse(r.alternatives_json) as string[], occurrences: JSON.parse(r.positions_json) as TermRange[], createdAt: r.created_at });

function candidates(db: SqliteDb, projectId: string, documentId: string, dismissed: 0 | 1): TermCandidate[] {
  const rows = db.prepare("SELECT * FROM term_candidates WHERE project_id = ? AND document_node_id = ? AND dismissed = ? ORDER BY created_at, id").all(projectId, documentId, dismissed) as CandidateRow[];
  return rows.map(candidateFromRow).sort((a, b) => (a.occurrences[0]?.from ?? 0) - (b.occurrences[0]?.from ?? 0));
}

function previousLinks(db: SqliteDb, projectId: string, documentId: string, versionId: string | null): DocumentTerm[] {
  const rows = db.prepare("SELECT * FROM document_terms WHERE project_id = ? AND document_node_id = ? AND punctuation_version_id IS NOT ? ORDER BY created_at, id").all(projectId, documentId, versionId) as LinkRow[];
  return linksFromRows(db, projectId, rows);
}

export function documentTerms(db: SqliteDb, projectId: string, documentId: string): DocumentTermsView {
  const basis = termBasis(db, projectId, documentId);
  return {
    basis,
    terms: basis ? versionLinks(db, projectId, basis.punctuationVersionId) : [],
    candidates: basis ? candidates(db, projectId, documentId, 0).filter(c => c.punctuationVersionId === basis.punctuationVersionId) : [],
    previousCount: previousLinks(db, projectId, documentId, basis?.punctuationVersionId ?? null).length,
  };
}

/** Reads each document's use of a term. A document keeps a previous-version link until its next review; the current one wins. */
function termUses(db: SqliteDb, projectId: string): (termId: string) => Array<ProjectTermUse & { linkId: string }> {
  const links = db.prepare(`SELECT dt.id AS linkId, dn.id, dn.title, dt.punctuation_version_id AS versionId, pv.version_no AS versionNo, dt.context_note AS contextNote,
      (SELECT COUNT(*) FROM term_occurrences o WHERE o.document_term_id = dt.id) AS occurrences
    FROM document_terms dt JOIN document_nodes dn ON dn.id = dt.document_node_id JOIN punctuation_versions pv ON pv.id = dt.punctuation_version_id
    WHERE dt.term_id = ? AND dn.archived_at IS NULL ORDER BY dn.title, pv.version_no DESC`);
  const bases = new Map<string, string | null>();
  const basisOf = (documentId: string) => {
    if (!bases.has(documentId)) bases.set(documentId, basisRow(db, projectId, documentId)?.id ?? null);
    return bases.get(documentId);
  };
  return termId => {
    const uses = new Map<string, ProjectTermUse & { linkId: string }>();
    for (const { versionId, ...link } of links.all(termId) as Array<Omit<ProjectTermUse, "current"> & { linkId: string; versionId: string }>) {
      const use = { ...link, current: versionId === basisOf(link.id) };
      if (!uses.get(link.id) || use.current) uses.set(link.id, use);
    }
    return [...uses.values()];
  };
}

export function projectTerms(db: SqliteDb, projectId: string): ProjectTermListItem[] {
  const rows = db.prepare("SELECT * FROM terms WHERE project_id = ? ORDER BY source_form, created_at").all(projectId) as TermRow[];
  const usesOf = termUses(db, projectId);
  return rows.map(row => ({ ...termFromRow(row), documents: usesOf(row.id).map(({ linkId: _link, ...use }) => use) }));
}

/** How many documents get sentences when a term opens, and how many sentences each gets before the rest are asked for. */
export const TERM_SENTENCE_PREVIEW = { documents: 10, sentences: 3 } as const;

/**
 * The sentences holding one term, keyed by document id. Without a document, only the first documents get their first
 * sentences; with one, that document gets all of its sentences. Each position names its stored sentence, so only the
 * sentences returned are read.
 */
export function termSentences(db: SqliteDb, projectId: string, termId: string, documentId?: string): Record<string, TermSentencePage> {
  if (!getTerm(db, projectId, termId)) throw new MunhaeError("not_found", "용어를 찾을 수 없습니다.");
  const total = db.prepare("SELECT COUNT(DISTINCT sentence_span_id) AS total FROM term_occurrences WHERE document_term_id = ?");
  const held = db.prepare(`SELECT s.id AS spanId, s.quote, s.codepoint_from AS spanFrom, o.codepoint_from AS "from", o.codepoint_to AS "to"
    FROM (SELECT sentence_span_id, MIN(codepoint_from) AS first FROM term_occurrences WHERE document_term_id = ? AND sentence_span_id IS NOT NULL
      GROUP BY sentence_span_id ORDER BY first LIMIT ?) picked
    JOIN punctuation_structure_spans s ON s.id = picked.sentence_span_id
    JOIN term_occurrences o ON o.document_term_id = ? AND o.sentence_span_id = picked.sentence_span_id
    ORDER BY o.codepoint_from`);
  const uses = termUses(db, projectId)(termId);
  const chosen = documentId === undefined ? uses.slice(0, TERM_SENTENCE_PREVIEW.documents) : uses.filter(use => use.id === documentId);
  return Object.fromEntries(chosen.map(use => {
    const bySpan = new Map<string, TermSentence>();
    for (const r of held.all(use.linkId, documentId === undefined ? TERM_SENTENCE_PREVIEW.sentences : -1, use.linkId) as Array<{ spanId: string; quote: string; spanFrom: number; from: number; to: number }>) {
      const sentence = bySpan.get(r.spanId) ?? { text: r.quote, marks: [] };
      sentence.marks.push({ from: r.from - r.spanFrom, to: r.to - r.spanFrom });
      bySpan.set(r.spanId, sentence);
    }
    return [use.id, { sentences: [...bySpan.values()], total: (total.get(use.linkId) as { total: number }).total }];
  }));
}

/** Confirmed uses in the current basis. Nothing else reaches a translation request. */
export function termsForTranslation(db: SqliteDb, projectId: string, documentId: string): { basis: TermBasis; terms: DocumentTerm[] } | null {
  const basis = termBasis(db, projectId, documentId);
  return basis ? { basis, terms: versionLinks(db, projectId, basis.punctuationVersionId) } : null;
}

/** The sentences in which a confirmed term occurs, as the AI reads it. */
export function termMaterial(basis: TermBasis, link: DocumentTerm): Record<string, unknown> {
  const points = Array.from(basis.text);
  const sentences = [...new Set(link.occurrences.map(o => basis.sentences.find(s => s.from <= o.from && s.to >= o.to))
    .filter((s): s is TermRange => !!s).map(s => points.slice(s.from, s.to).join("")))];
  const { id: _id, lockVersion: _lock, createdAt: _created, updatedAt: _updated, ...term } = link.term;
  return { ...term, contextNote: link.contextNote, confidence: link.confidence, alternatives: link.alternatives, sentences };
}

/** Terms confirmed elsewhere in the project whose written form occurs in this basis. */
export function referenceTerms(db: SqliteDb, projectId: string, basis: TermBasis): Array<ProjectTerm & { documents: string[] }> {
  const rows = db.prepare(`SELECT DISTINCT t.* FROM terms t JOIN document_terms dt ON dt.term_id = t.id
    WHERE t.project_id = ? AND dt.document_node_id != ? ORDER BY t.source_form, t.created_at`).all(projectId, basis.documentId) as TermRow[];
  const titles = db.prepare(`SELECT DISTINCT dn.title FROM document_terms dt JOIN document_nodes dn ON dn.id = dt.document_node_id
    WHERE dt.term_id = ? AND dt.document_node_id != ? AND dn.archived_at IS NULL ORDER BY dn.title`);
  return rows.filter(row => basis.text.includes(row.source_form))
    .map(row => ({ ...termFromRow(row), documents: (titles.all(row.id, basis.documentId) as { title: string }[]).map(t => t.title) }));
}

export function termGenerationInput(db: SqliteDb, projectId: string, documentId: string) {
  const basis = requireBasis(db, projectId, documentId);
  return {
    basis,
    current: versionLinks(db, projectId, basis.punctuationVersionId),
    previous: previousLinks(db, projectId, documentId, basis.punctuationVersionId),
    references: referenceTerms(db, projectId, basis),
    dismissed: candidates(db, projectId, documentId, 1),
  };
}

function assertFreePositions(db: SqliteDb, versionId: string, ranges: TermRange[], ownLinkId: string | null): void {
  const taken = db.prepare(`SELECT t.source_form FROM term_occurrences o JOIN document_terms dt ON dt.id = o.document_term_id JOIN terms t ON t.id = dt.term_id
    WHERE o.punctuation_version_id = ? AND o.codepoint_from = ? AND o.codepoint_to = ? AND o.document_term_id IS NOT ?`);
  for (const range of ranges) {
    const row = taken.get(versionId, range.from, range.to, ownLinkId) as { source_form: string } | undefined;
    if (row) throw new MunhaeError("conflict", `같은 자리가 이미 다른 ‘${row.source_form}’ 용어에 연결되어 있습니다.`);
  }
}

/** Each position keeps the sentence that holds it, taken from the basis already in hand. */
function insertOccurrences(db: SqliteDb, projectId: string, linkId: string, { basis, sentenceIds }: LoadedBasis, ranges: TermRange[]): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO term_occurrences(id, project_id, document_term_id, punctuation_version_id, codepoint_from, codepoint_to, sentence_span_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const range of ranges) {
    const sentence = sentenceIds[basis.sentences.findIndex(s => s.from <= range.from && s.to >= range.to)] ?? null;
    insert.run(createId(), projectId, linkId, basis.punctuationVersionId, range.from, range.to, sentence);
  }
}

function deleteOrphanTerms(db: SqliteDb, projectId: string): void {
  db.prepare(`DELETE FROM terms WHERE project_id = ?
    AND NOT EXISTS (SELECT 1 FROM document_terms dt WHERE dt.term_id = terms.id)
    AND NOT EXISTS (SELECT 1 FROM term_candidates c WHERE c.suggested_term_id = terms.id AND c.dismissed = 0)`).run(projectId);
}

/** Once every candidate of the current version is decided, earlier versions have served as reference. */
function finishReviewIfDone(db: SqliteDb, projectId: string, basis: TermBasis): void {
  const pending = db.prepare("SELECT COUNT(*) AS count FROM term_candidates WHERE project_id = ? AND document_node_id = ? AND dismissed = 0").get(projectId, basis.documentId) as { count: number };
  if (pending.count) return;
  db.prepare("DELETE FROM document_terms WHERE project_id = ? AND document_node_id = ? AND punctuation_version_id != ?").run(projectId, basis.documentId, basis.punctuationVersionId);
  deleteOrphanTerms(db, projectId);
}

export function confirmDocumentTerm(db: SqliteDb, projectId: string, input: ConfirmTermInput): DocumentTerm {
  if (!input || typeof input.documentId !== "string" || typeof input.punctuationVersionId !== "string") invalid("확정할 용어를 확인하세요.");
  const notes = validateTermNotes(input);
  const ranges = validateRanges(input.occurrences);
  return db.transaction(() => {
    const loaded = requireLoadedBasis(db, projectId, input.documentId, input.punctuationVersionId), { basis } = loaded;
    let candidate: CandidateRow | undefined;
    if (input.candidateId) {
      candidate = db.prepare("SELECT * FROM term_candidates WHERE id = ? AND project_id = ? AND document_node_id = ? AND dismissed = 0").get(input.candidateId, projectId, input.documentId) as CandidateRow | undefined;
      if (!candidate) throw new MunhaeError("not_found", "용어 후보를 찾을 수 없습니다. 새로고침하세요.");
      if (candidate.punctuation_version_id !== basis.punctuationVersionId) throw new MunhaeError("conflict", "이전 표점본에서 만든 후보입니다. 용어를 다시 생성하세요.");
    }
    const now = nowIso();
    let term: ProjectTerm;
    if (input.termId) {
      term = getTerm(db, projectId, input.termId) ?? (() => { throw new MunhaeError("not_found", "연결할 용어를 찾을 수 없습니다."); })();
    } else {
      const content = validateTermContent(input.term);
      const id = createId();
      db.prepare(`INSERT INTO terms(id, project_id, source_form, kind, reading, translation, definition, evidence_json, lock_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(id, projectId, content.sourceForm, content.kind, content.reading, content.translation, content.definition, JSON.stringify(content.evidence), now, now);
      term = getTerm(db, projectId, id)!;
    }
    assertRanges(basis, term.sourceForm, ranges);
    const existing = db.prepare("SELECT * FROM document_terms WHERE punctuation_version_id = ? AND term_id = ?").get(basis.punctuationVersionId, term.id) as LinkRow | undefined;
    assertFreePositions(db, basis.punctuationVersionId, ranges, existing?.id ?? null);
    const generation = candidate ? JSON.stringify({ runId: candidate.run_id, agentId: candidate.agent_id, model: candidate.model }) : null;
    let linkId: string;
    if (existing) {
      // A second confirmation of the same term adds positions; the written judgment stays unless empty.
      linkId = existing.id;
      db.prepare(`UPDATE document_terms SET context_note = COALESCE(context_note, ?),
        alternatives_json = CASE WHEN alternatives_json = '[]' THEN ? ELSE alternatives_json END, lock_version = lock_version + 1, updated_at = ? WHERE id = ?`)
        .run(notes.contextNote, JSON.stringify(notes.alternatives), now, linkId);
    } else {
      linkId = createId();
      db.prepare(`INSERT INTO document_terms(id, project_id, document_node_id, term_id, punctuation_version_id, context_note, confidence, alternatives_json, origin, generation_json, lock_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(linkId, projectId, input.documentId, term.id, basis.punctuationVersionId, notes.contextNote, notes.confidence, JSON.stringify(notes.alternatives), candidate ? "ai" : "manual", generation, now, now);
    }
    insertOccurrences(db, projectId, linkId, loaded, ranges);
    if (candidate) {
      db.prepare("DELETE FROM term_candidates WHERE id = ?").run(candidate.id);
      finishReviewIfDone(db, projectId, basis);
    }
    return getLink(db, projectId, linkId)!;
  })();
}

export function dismissTermCandidate(db: SqliteDb, projectId: string, input: { id: string }): void {
  if (!input || typeof input.id !== "string") invalid("버릴 후보를 확인하세요.");
  db.transaction(() => {
    const row = db.prepare("SELECT document_node_id FROM term_candidates WHERE id = ? AND project_id = ? AND dismissed = 0").get(input.id, projectId) as { document_node_id: string } | undefined;
    if (!row) throw new MunhaeError("not_found", "용어 후보를 찾을 수 없습니다. 새로고침하세요.");
    db.prepare("UPDATE term_candidates SET dismissed = 1 WHERE id = ?").run(input.id);
    const basis = termBasis(db, projectId, row.document_node_id);
    if (basis) finishReviewIfDone(db, projectId, basis);
  })();
}

export function updateTerm(db: SqliteDb, projectId: string, input: UpdateTermInput): ProjectTerm {
  if (!input || typeof input.id !== "string" || !Number.isSafeInteger(input.expectedLockVersion)) invalid("수정할 용어를 확인하세요.");
  return db.transaction(() => {
    const current = getTerm(db, projectId, input.id);
    if (!current) throw new MunhaeError("not_found", "용어를 찾을 수 없습니다.");
    // The written form is fixed: confirmed positions hold exactly that form.
    const content = validateTermContent({ ...input, sourceForm: current.sourceForm });
    const result = db.prepare(`UPDATE terms SET kind = ?, reading = ?, translation = ?, definition = ?, evidence_json = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND lock_version = ?`).run(content.kind, content.reading, content.translation, content.definition, JSON.stringify(content.evidence), nowIso(), input.id, projectId, input.expectedLockVersion);
    if (result.changes !== 1) throw new MunhaeError("conflict", "용어가 다른 화면에서 변경되었습니다. 다시 불러오세요.");
    return getTerm(db, projectId, input.id)!;
  })();
}

export function updateDocumentTerm(db: SqliteDb, projectId: string, input: UpdateDocumentTermInput): DocumentTerm {
  if (!input || typeof input.id !== "string" || !Number.isSafeInteger(input.expectedLockVersion)) invalid("수정할 용어를 확인하세요.");
  const notes = validateTermNotes(input);
  const ranges = input.occurrences === undefined ? null : validateRanges(input.occurrences);
  return db.transaction(() => {
    const link = getLink(db, projectId, input.id);
    if (!link) throw new MunhaeError("not_found", "용어를 찾을 수 없습니다.");
    const loaded = ranges ? requireLoadedBasis(db, projectId, link.documentId, link.punctuationVersionId) : null;
    if (ranges && loaded) {
      assertRanges(loaded.basis, link.term.sourceForm, ranges);
      assertFreePositions(db, loaded.basis.punctuationVersionId, ranges, link.id);
    }
    const result = db.prepare(`UPDATE document_terms SET context_note = ?, confidence = ?, alternatives_json = ?, lock_version = lock_version + 1, updated_at = ?
      WHERE id = ? AND project_id = ? AND lock_version = ?`).run(notes.contextNote, notes.confidence, JSON.stringify(notes.alternatives), nowIso(), link.id, projectId, input.expectedLockVersion);
    if (result.changes !== 1) throw new MunhaeError("conflict", "용어가 다른 화면에서 변경되었습니다. 다시 불러오세요.");
    if (ranges && loaded) {
      db.prepare("DELETE FROM term_occurrences WHERE document_term_id = ?").run(link.id);
      insertOccurrences(db, projectId, link.id, loaded, ranges);
    }
    return getLink(db, projectId, link.id)!;
  })();
}

export function deleteDocumentTerm(db: SqliteDb, projectId: string, input: { id: string; expectedLockVersion: number }): void {
  if (!input || typeof input.id !== "string" || !Number.isSafeInteger(input.expectedLockVersion)) invalid("삭제할 용어를 확인하세요.");
  db.transaction(() => {
    const result = db.prepare("DELETE FROM document_terms WHERE id = ? AND project_id = ? AND lock_version = ?").run(input.id, projectId, input.expectedLockVersion);
    if (result.changes !== 1) {
      const exists = db.prepare("SELECT 1 FROM document_terms WHERE id = ? AND project_id = ?").get(input.id, projectId);
      throw new MunhaeError(exists ? "conflict" : "not_found", exists ? "용어가 다른 화면에서 변경되었습니다. 다시 불러오세요." : "용어를 찾을 수 없습니다.");
    }
    deleteOrphanTerms(db, projectId);
  })();
}

/**
 * Removes terms from the whole project, all or none: every document's confirmed link and its positions go with
 * each term, and AI candidates that pointed at it keep their suggestion without the link.
 */
export function deleteTerms(db: SqliteDb, projectId: string, input: { terms: Array<{ id: string; expectedLockVersion: number }> }): void {
  const items = input?.terms;
  if (!Array.isArray(items) || items.length === 0 || items.length > 1000
    || items.some(item => !item || typeof item.id !== "string" || !Number.isSafeInteger(item.expectedLockVersion))) invalid("삭제할 용어를 확인하세요.");
  const unique = new Map(items.map(item => [item.id, item.expectedLockVersion]));
  db.transaction(() => {
    const removeLinks = db.prepare("DELETE FROM document_terms WHERE term_id = ? AND project_id = ?");
    const removeTerm = db.prepare("DELETE FROM terms WHERE id = ? AND project_id = ? AND lock_version = ?");
    for (const [id, expectedLockVersion] of unique) {
      const current = getTerm(db, projectId, id);
      if (!current) throw new MunhaeError("not_found", "용어를 찾을 수 없습니다. 다시 불러오세요.");
      if (current.lockVersion !== expectedLockVersion) throw new MunhaeError("conflict", "용어가 다른 화면에서 변경되었습니다. 다시 불러오세요.");
      removeLinks.run(id, projectId);
      removeTerm.run(id, projectId, expectedLockVersion);
    }
  })();
}

/** Terms whose every confirmed link is in these documents, given as a JSON array of ids. */
const OWN_TERMS = `SELECT t.id FROM terms t WHERE t.project_id = ?
  AND EXISTS (SELECT 1 FROM document_terms dt WHERE dt.term_id = t.id AND dt.document_node_id IN (SELECT value FROM json_each(?)))
  AND NOT EXISTS (SELECT 1 FROM document_terms dt WHERE dt.term_id = t.id AND dt.document_node_id NOT IN (SELECT value FROM json_each(?)))`;

export function ownTermCount(db: SqliteDb, projectId: string, documentIds: readonly string[]): number {
  const ids = JSON.stringify(documentIds);
  return (db.prepare(`SELECT COUNT(*) AS count FROM (${OWN_TERMS})`).get(projectId, ids, ids) as { count: number }).count;
}

/**
 * Clears these documents' term review: their links, positions and candidates, and the terms no other document
 * confirmed. Terms another document uses lose only these links. Runs inside the caller's transaction.
 */
export function removeDocumentTerms(db: SqliteDb, projectId: string, documentIds: readonly string[]): void {
  const ids = JSON.stringify(documentIds);
  const own = JSON.stringify((db.prepare(OWN_TERMS).all(projectId, ids, ids) as Array<{ id: string }>).map(row => row.id));
  db.prepare("DELETE FROM document_terms WHERE project_id = ? AND document_node_id IN (SELECT value FROM json_each(?))").run(projectId, ids);
  db.prepare("DELETE FROM term_candidates WHERE project_id = ? AND document_node_id IN (SELECT value FROM json_each(?))").run(projectId, ids);
  db.prepare("DELETE FROM terms WHERE project_id = ? AND id IN (SELECT value FROM json_each(?))").run(projectId, own);
  deleteOrphanTerms(db, projectId);
}

/** Replaces undecided candidates only when the whole generation succeeded on the current basis. */
/** A generation run replaces the undecided candidates; `keepExisting` adds to them instead. */
export function storeTermCandidates(db: SqliteDb, projectId: string, documentId: string, versionId: string, items: TermCandidateInput[], generation: TermGeneration, keepExisting = false): TermCandidate[] {
  return db.transaction(() => {
    const basis = requireBasis(db, projectId, documentId, versionId);
    if (!keepExisting) db.prepare("DELETE FROM term_candidates WHERE project_id = ? AND document_node_id = ? AND dismissed = 0").run(projectId, documentId);
    const insert = db.prepare(`INSERT INTO term_candidates(id, project_id, document_node_id, punctuation_version_id, run_id, agent_id, model, suggested_term_id, source_form, kind, reading, translation, definition, evidence_json, context_note, confidence, alternatives_json, positions_json, dismissed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`);
    const now = nowIso();
    for (const item of items) {
      const content = validateTermContent(item), notes = validateTermNotes(item), ranges = validateRanges(item.occurrences);
      assertRanges(basis, content.sourceForm, ranges);
      const suggested = item.suggestedTermId ? getTerm(db, projectId, item.suggestedTermId) : null;
      insert.run(createId(), projectId, documentId, basis.punctuationVersionId, generation.runId, generation.agentId, generation.model,
        suggested?.sourceForm === content.sourceForm ? suggested.id : null, content.sourceForm, content.kind, content.reading, content.translation,
        content.definition, JSON.stringify(content.evidence), notes.contextNote, notes.confidence, JSON.stringify(notes.alternatives), JSON.stringify(ranges), now);
    }
    return candidates(db, projectId, documentId, 0);
  })();
}

/** A newly confirmed punctuation version makes undecided candidates of older versions meaningless. */
export function discardStaleCandidates(db: SqliteDb, projectId: string, documentId: string, versionId: string): void {
  db.prepare("DELETE FROM term_candidates WHERE project_id = ? AND document_node_id = ? AND dismissed = 0 AND punctuation_version_id != ?").run(projectId, documentId, versionId);
  deleteOrphanTerms(db, projectId);
}

type SnapshotRow = Record<string, unknown>;
/** Every row one document's term review can change, so an edit made from outside the app can be undone exactly. */
export type TermRowsSnapshot = { documentId: string; candidates: SnapshotRow[]; links: SnapshotRow[]; occurrences: SnapshotRow[]; terms: SnapshotRow[] };

const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/** `extraTermIds` keeps project terms in view that the document stopped using, e.g. ones an edit removed. */
export function snapshotTermRows(db: SqliteDb, projectId: string, documentId: string, extraTermIds: readonly string[] = []): TermRowsSnapshot {
  const candidates = db.prepare("SELECT * FROM term_candidates WHERE project_id = ? AND document_node_id = ? ORDER BY id").all(projectId, documentId) as SnapshotRow[];
  const links = db.prepare("SELECT * FROM document_terms WHERE project_id = ? AND document_node_id = ? ORDER BY id").all(projectId, documentId) as SnapshotRow[];
  const linkIds = links.map(link => link.id as string);
  const occurrences = linkIds.length
    ? db.prepare(`SELECT * FROM term_occurrences WHERE document_term_id IN (${placeholders(linkIds)}) ORDER BY id`).all(...linkIds) as SnapshotRow[]
    : [];
  const termIds = [...new Set([
    ...links.map(link => link.term_id as string),
    ...candidates.map(candidate => candidate.suggested_term_id).filter((id): id is string => typeof id === "string"),
    ...extraTermIds,
  ])].sort();
  const terms = termIds.length
    ? db.prepare(`SELECT * FROM terms WHERE project_id = ? AND id IN (${placeholders(termIds)}) ORDER BY id`).all(projectId, ...termIds) as SnapshotRow[]
    : [];
  return { documentId, candidates, links, occurrences, terms };
}

const TERM_TABLES = { links: "document_terms", occurrences: "term_occurrences", candidates: "term_candidates" } as const;

/**
 * Puts one document's term rows back to `before`, only while they are still exactly `after`.
 * `after` must be read with `before`'s term ids as extras, so both cover the same project terms.
 * Restored rows get a newer lock version than `after`, so screens holding the undone state must reload.
 */
export function restoreTermRows(db: SqliteDb, projectId: string, before: TermRowsSnapshot, after: TermRowsSnapshot): void {
  if (before.documentId !== after.documentId) invalid("되돌릴 문서를 확인하세요.");
  db.transaction(() => {
    const current = snapshotTermRows(db, projectId, before.documentId, [...before.terms, ...after.terms].map(term => term.id as string));
    if (JSON.stringify(current) !== JSON.stringify(after)) throw new MunhaeError("conflict", "이후에 바뀐 내용이 있어 되돌릴 수 없습니다.");
    const bump = (rows: SnapshotRow[], later: SnapshotRow[]) => rows.map(row => {
      const newer = later.find(item => item.id === row.id);
      return newer && "lock_version" in row ? { ...row, lock_version: Number(newer.lock_version) + 1 } : row;
    });
    db.prepare("DELETE FROM term_candidates WHERE project_id = ? AND document_node_id = ?").run(projectId, before.documentId);
    db.prepare("DELETE FROM document_terms WHERE project_id = ? AND document_node_id = ?").run(projectId, before.documentId);
    for (const term of bump(before.terms, after.terms)) {
      const columns = Object.keys(term).filter(column => column !== "id");
      const exists = db.prepare("SELECT 1 FROM terms WHERE id = ? AND project_id = ?").get(term.id, projectId);
      if (exists) db.prepare(`UPDATE terms SET ${columns.map(column => `${column} = ?`).join(", ")} WHERE id = ?`).run(...columns.map(column => term[column]), term.id);
      else db.prepare(`INSERT INTO terms (id, ${columns.join(", ")}) VALUES (?, ${placeholders(columns)})`).run(term.id, ...columns.map(column => term[column]));
    }
    for (const key of ["links", "occurrences", "candidates"] as const) {
      for (const row of bump(before[key], after[key])) {
        const columns = Object.keys(row);
        db.prepare(`INSERT INTO ${TERM_TABLES[key]} (${columns.join(", ")}) VALUES (${placeholders(columns)})`).run(...columns.map(column => row[column]));
      }
    }
    deleteOrphanTerms(db, projectId);
  })();
}
