import { canonicalJson, createId, MunhaeError, nowIso } from "@munhae/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as t } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";

export const NOTE_KINDS = ["textual", "allusion", "identification", "interpretive"] as const;
export const NOTE_CONFIDENCE = ["certain", "probable", "unknown"] as const;
export type TranslationNoteKind = typeof NOTE_KINDS[number];
export type TranslationNoteConfidence = typeof NOTE_CONFIDENCE[number];
/** A translator's footnote on one translation version. A null range means its quote no longer occurs there. */
export type TranslationNote = {
  id: string;
  ordinal: number;
  kind: TranslationNoteKind;
  confidence: TranslationNoteConfidence;
  targetQuote: string;
  from: number | null;
  to: number | null;
  sourceQuote: string | null;
  bodyMd: string;
  alternatives: string[];
  origin: "ai" | "human";
};
type NoteDraft = Omit<TranslationNote, "id" | "ordinal"> & { previousNoteId?: string };
/** A note a person places on an exact phrase of the current draft. */
export type CreateTranslationNoteInput = {
  documentNodeId: string;
  versionId: string;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  kind: TranslationNoteKind;
  confidence: TranslationNoteConfidence;
  bodyMd: string;
  alternatives: string[];
};
export type DeleteTranslationNoteInput = { documentNodeId: string; versionId: string; noteId: string };
export type UpdateTranslationNoteInput = DeleteTranslationNoteInput
  & Pick<CreateTranslationNoteInput, "kind" | "confidence" | "bodyMd" | "alternatives">;

export const MAX_NOTES = 100;
const MAX_QUOTE = 300, MAX_BODY = 2000, MAX_ALTERNATIVES = 3;

/** The `footnotes` item schema shown to the model. */
export const footnoteSchema = {
  type: "object",
  additionalProperties: false,
  required: ["target", "kind", "confidence", "body"],
  properties: {
    target: {
      type: "object",
      additionalProperties: false,
      required: ["quote"],
      properties: { quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE }, occurrence: { type: "integer", minimum: 1 } },
    },
    source: {
      type: "object",
      additionalProperties: false,
      required: ["quote"],
      properties: { quote: { type: "string", minLength: 1, maxLength: MAX_QUOTE } },
    },
    kind: { enum: NOTE_KINDS },
    confidence: { enum: NOTE_CONFIDENCE },
    body: { type: "string", minLength: 1, maxLength: MAX_BODY },
    alternatives: { type: "array", maxItems: MAX_ALTERNATIVES, items: { type: "string", minLength: 1, maxLength: MAX_QUOTE } },
  },
};

const points = (text: string) => Array.from(text);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" && value.trim() && points(value.trim()).length <= max ? value.trim() : null;
function occurrences(haystack: string[], needle: string[]): number[] {
  const found: number[] = [];
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    found.push(i);
  }
  return found;
}

/**
 * Footnotes never cost the translation they annotate: a malformed note is dropped
 * (the raw response keeps it) and a note whose quote cannot be placed is kept unplaced.
 */
export function parseFootnotes(raw: unknown, translation: string): { notes: NoteDraft[]; dropped: number } {
  if (raw === undefined) return { notes: [], dropped: 0 };
  if (!Array.isArray(raw)) return { notes: [], dropped: 1 };
  const translated = points(translation);
  const notes: NoteDraft[] = [];
  let dropped = Math.max(0, raw.length - MAX_NOTES);
  for (const item of raw.slice(0, MAX_NOTES)) {
    const note = isRecord(item) ? item : {};
    const target = isRecord(note.target) ? note.target : {};
    const quote = text(target.quote, MAX_QUOTE), body = text(note.body, MAX_BODY);
    const kind = NOTE_KINDS.find(k => k === note.kind), confidence = NOTE_CONFIDENCE.find(c => c === note.confidence);
    if (!quote || !body || !kind || !confidence || body === quote) { dropped++; continue; }
    const at = occurrences(translated, points(quote));
    const occurrence = typeof target.occurrence === "number" && Number.isSafeInteger(target.occurrence) && target.occurrence >= 1 ? target.occurrence : 1;
    const from = at[occurrence - 1] ?? (at.length === 1 ? at[0]! : null);
    notes.push({
      kind, confidence, targetQuote: quote, bodyMd: body, origin: "ai",
      sourceQuote: isRecord(note.source) ? text(note.source.quote, MAX_QUOTE) : null,
      alternatives: Array.isArray(note.alternatives)
        ? note.alternatives.map(a => text(a, MAX_QUOTE)).filter((a): a is string => a !== null).slice(0, MAX_ALTERNATIVES)
        : [],
      from, to: from === null ? null : from + points(quote).length,
    });
  }
  return { notes, dropped };
}

/** Numbers follow position in the translation; unplaced notes come last. */
export function insertNotes(db: SqliteDb, projectId: string, versionId: string, notes: NoteDraft[]): void {
  const now = nowIso();
  const ordered = notes.map((note, index) => ({ note, index }))
    .sort((a, b) => (a.note.from ?? Infinity) - (b.note.from ?? Infinity) || a.index - b.index);
  ordered.forEach(({ note }, index) => orm(db).insert(t.translation_notes).values({
    id: createId(), project_id: projectId, version_id: versionId, ordinal: index + 1,
    kind: note.kind, confidence: note.confidence, target_quote: note.targetQuote,
    codepoint_from: note.from, codepoint_to: note.to, source_quote: note.sourceQuote, body_md: note.bodyMd,
    alternatives_json: canonicalJson(note.alternatives), origin_kind: note.origin,
    previous_note_id: note.previousNoteId ?? null, created_at: now,
  }).run());
}

export function loadNotes(db: SqliteDb, versionId: string): TranslationNote[] {
  return orm(db).select().from(t.translation_notes).where(eq(t.translation_notes.version_id, versionId))
    .orderBy(asc(t.translation_notes.ordinal)).all().map(row => ({
      id: row.id, ordinal: row.ordinal, kind: row.kind, confidence: row.confidence, targetQuote: row.target_quote,
      from: row.codepoint_from, to: row.codepoint_to, sourceQuote: row.source_quote, bodyMd: row.body_md,
      alternatives: JSON.parse(row.alternatives_json) as string[], origin: row.origin_kind,
    }));
}

/**
 * An edited version keeps its predecessor's notes. While a quote occurs as often as before,
 * the note stays on the same occurrence; otherwise it takes the one nearest its old position.
 */
export function carryNotes(db: SqliteDb, projectId: string, fromVersionId: string, toVersionId: string, translation: string): void {
  const previous = loadNotes(db, fromVersionId);
  if (!previous.length) return;
  const before = points(orm(db).select({ text: t.document_translation_versions.text_content }).from(t.document_translation_versions)
    .where(eq(t.document_translation_versions.id, fromVersionId)).get()!.text);
  const after = points(translation);
  insertNotes(db, projectId, toVersionId, previous.map(({ id, ordinal: _ordinal, ...note }) => {
    const quote = points(note.targetQuote);
    const old = occurrences(before, quote), now = occurrences(after, quote);
    const rank = note.from === null ? -1 : old.indexOf(note.from);
    const anchor = note.from ?? 0;
    const from = rank >= 0 && old.length === now.length ? now[rank]!
      : now.length ? now.reduce((best, x) => Math.abs(x - anchor) < Math.abs(best - anchor) ? x : best) : null;
    return { ...note, from, to: from === null ? null : from + quote.length, previousNoteId: id };
  }));
}

const invalid = (message: string): never => { throw new MunhaeError("invalid_input", message); };

function noteContent(input: Pick<CreateTranslationNoteInput, "kind" | "confidence" | "bodyMd" | "alternatives">) {
  return {
    kind: NOTE_KINDS.find(k => k === input.kind) ?? invalid("각주 종류를 고르세요"),
    confidence: NOTE_CONFIDENCE.find(c => c === input.confidence) ?? invalid("확신도를 고르세요"),
    body: text(input.bodyMd, MAX_BODY) ?? invalid("각주 내용을 2,000자 이하로 입력하세요"),
    alternatives: input.alternatives.map(a => text(a, MAX_QUOTE)).filter((a): a is string => a !== null).slice(0, MAX_ALTERNATIVES),
  };
}

/** Numbers follow position after every change; unplaced notes keep their order at the end. */
function renumber(db: SqliteDb, versionId: string): TranslationNote[] {
  const notes = loadNotes(db, versionId);
  const ordered = [...notes].sort((a, b) => (a.from ?? Infinity) - (b.from ?? Infinity) || a.ordinal - b.ordinal);
  // (version_id, ordinal) is unique, so move every row out of the way first.
  orm(db).update(t.translation_notes).set({ ordinal: sql`${t.translation_notes.ordinal} + 100000` }).where(eq(t.translation_notes.version_id, versionId)).run();
  ordered.forEach((note, index) => orm(db).update(t.translation_notes).set({ ordinal: index + 1 }).where(eq(t.translation_notes.id, note.id)).run());
  return loadNotes(db, versionId);
}

export function addNote(db: SqliteDb, projectId: string, versionId: string, translation: string, input: CreateTranslationNoteInput): TranslationNote[] {
  const quote = text(input.quote, MAX_QUOTE) ?? invalid("각주를 달 구절은 300자 이하로 선택하세요");
  const translated = points(translation);
  if (!Number.isSafeInteger(input.codepointFrom) || !Number.isSafeInteger(input.codepointTo) || input.codepointFrom < 0
    || input.codepointTo > translated.length || translated.slice(input.codepointFrom, input.codepointTo).join("") !== input.quote)
    invalid("선택한 구절이 현재 번역과 맞지 않습니다. 다시 선택하세요");
  const { kind, confidence, body, alternatives } = noteContent(input);
  // Surrounding whitespace in a selection is not part of the phrase.
  const lead = points(input.quote).length - points(input.quote.trimStart()).length;
  const from = input.codepointFrom + lead;
  const last = orm(db).select({ n: sql<number>`coalesce(max(${t.translation_notes.ordinal}), 0)` }).from(t.translation_notes)
    .where(eq(t.translation_notes.version_id, versionId)).get()!.n;
  orm(db).insert(t.translation_notes).values({
    id: createId(), project_id: projectId, version_id: versionId, ordinal: last + 1, kind, confidence,
    target_quote: quote, codepoint_from: from, codepoint_to: from + points(quote).length, source_quote: null, body_md: body,
    alternatives_json: canonicalJson(alternatives), origin_kind: "human", previous_note_id: null, created_at: nowIso(),
  }).run();
  return renumber(db, versionId);
}

export function removeNote(db: SqliteDb, versionId: string, noteId: string): TranslationNote[] {
  const removed = orm(db).delete(t.translation_notes)
    .where(and(eq(t.translation_notes.id, noteId), eq(t.translation_notes.version_id, versionId))).run();
  if (!removed.changes) throw new MunhaeError("not_found", "각주를 찾지 못했습니다. 다시 불러오세요");
  return renumber(db, versionId);
}

/** A note a person rewrites becomes theirs; saving it unchanged keeps its origin. */
export function updateNote(db: SqliteDb, versionId: string, input: UpdateTranslationNoteInput): TranslationNote[] {
  const current = loadNotes(db, versionId).find(note => note.id === input.noteId)
    ?? (() => { throw new MunhaeError("not_found", "각주를 찾지 못했습니다. 다시 불러오세요"); })();
  const { kind, confidence, body, alternatives } = noteContent(input);
  if (kind !== current.kind || confidence !== current.confidence || body !== current.bodyMd || canonicalJson(alternatives) !== canonicalJson(current.alternatives))
    orm(db).update(t.translation_notes)
      .set({ kind, confidence, body_md: body, alternatives_json: canonicalJson(alternatives), origin_kind: "human" })
      .where(and(eq(t.translation_notes.id, input.noteId), eq(t.translation_notes.version_id, versionId))).run();
  return loadNotes(db, versionId);
}
