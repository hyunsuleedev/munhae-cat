import { canonicalJson, createId, MunhaeError, sha256Hex } from "@munhae/domain";
import { groupedTextSentences } from "@munhae/domain/text-sentences";
import { and, eq, inArray } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as t } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { TextLayout, TextLink } from "./full-text.ts";

export type ContentGroup = { id: string; sentenceId: string; revision: number; spans: TextLink["spans"]; needsReview: boolean; reviewedBy?: "human" };
export type ContentPart = { id: string; groupId: string | null; kind: "text" | "whitespace"; orderKey: string; content: string; revision: number };
export type TranslationContent = { groups: ContentGroup[]; parts: ContentPart[] };
export type ContentRange = { id: string; sentenceId?: string; from: number; to: number; text: string; spans: TextLink["spans"]; needsReview?: boolean; reviewedBy?: "human" };
const invalid = (message: string): never => { throw new MunhaeError("invalid_submission", message); };
const conflict = (): never => { throw new MunhaeError("cas_conflict", "수정한 번역 묶음 또는 문단 경계가 변경되었습니다. 다시 불러오세요"); };
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const fraction = (key: string) => key.split("/").map(BigInt) as [bigint, bigint];
function compareOrder(a: ContentPart, b: ContentPart): number {
  const [an, ad] = fraction(a.orderKey), [bn, bd] = fraction(b.orderKey);
  const d = an * bd - bn * ad;
  return d < 0n ? -1 : d > 0n ? 1 : a.id.localeCompare(b.id);
}
function between(left?: string, right?: string): string {
  if (!left && !right) return "1/1";
  if (!right) { const [n, d] = fraction(left!); return `${n + d}/${d}`; }
  if (!left) { const [n, d] = fraction(right); return `${n - d}/${d}`; }
  const [an, ad] = fraction(left), [bn, bd] = fraction(right);
  return `${an + bn}/${ad + bd}`;
}
export function contentText(state: TranslationContent): string { return state.parts.map(p => p.content).join(""); }
export function contentRevision(state: TranslationContent): string { return sha256Hex(canonicalJson(state)); }
export function projectContent(state: TranslationContent, meta: Pick<TextLayout, "state" | "error">): TextLayout {
  let offset = 0;
  const ranges = new Map<string, { from: number; to: number }>();
  const closed = new Set<string>();
  let previous: string | null = null;
  for (const p of state.parts) {
    const end = offset + Array.from(p.content).length;
    if (p.kind === "text") {
      if (!p.groupId || !p.content.trim()) invalid("번역 내용 조각에 묶음이 없습니다");
      if (p.groupId !== previous) {
        if (previous) closed.add(previous);
        if (closed.has(p.groupId!)) invalid("한 번역 묶음의 내용은 연속되어야 합니다");
        previous = p.groupId;
      }
      const range = ranges.get(p.groupId!);
      ranges.set(p.groupId!, { from: range?.from ?? offset, to: end });
    } else if (!/^\s+$/u.test(p.content)) invalid("문단 경계에는 공백과 줄바꿈만 저장할 수 있습니다");
    offset = end;
  }
  const points = Array.from(contentText(state));
  const groups = [...state.groups].sort((a, b) => (ranges.get(a.id)?.from ?? Infinity) - (ranges.get(b.id)?.from ?? Infinity));
  if (new Set(groups.map(g => g.id)).size !== groups.length || new Set(groups.map(g => g.sentenceId)).size !== groups.length || ranges.size !== groups.length) invalid("번역 묶음과 내용 조각이 일치하지 않습니다");
  const sentences = groups.map(g => {
    const r = ranges.get(g.id) ?? invalid("빈 번역 묶음은 저장할 수 없습니다");
    return { id: g.sentenceId, ...r, text: points.slice(r.from, r.to).join("") };
  });
  return { ...meta, sentences, links: groups.map(g => ({ sentenceId: g.sentenceId, groupId: g.id, spans: g.spans, needsReview: g.needsReview, ...(g.reviewedBy ? { reviewedBy: g.reviewedBy } : {}) })), storageRevision: contentRevision(state) };
}
function slots(parts: Array<Pick<ContentPart, "kind" | "groupId">>): string[] {
  const count = new Map<string, number>();
  return parts.map((p, index) => {
    const left = p.kind === "whitespace" ? parts.slice(0, index).reverse().find(x => x.kind === "text")?.groupId ?? "^" : "";
    const right = p.kind === "whitespace" ? parts.slice(index + 1).find(x => x.kind === "text")?.groupId ?? "$" : "";
    const key = p.kind === "text" ? `text:${p.groupId}` : `gap:${left}:${right}`;
    const n = count.get(key) ?? 0; count.set(key, n + 1);
    return `${key}:${n}`;
  });
}
/** Convert a complete incoming draft to stable local entities; global offsets stop here. */
export function buildContent(text: string, ranges: ContentRange[], base: TranslationContent = { groups: [], parts: [] }, seed?: string): TranslationContent {
  const points = Array.from(text);
  let cursor = 0;
  const tokens: Array<Pick<ContentPart, "kind" | "groupId" | "content">> = [];
  const add = (content: string, groupId: string | null) => {
    if (!content) return;
    tokens.push({ kind: groupId ? "text" : "whitespace", groupId, content });
  };
  for (const r of ranges) {
    if (!Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.to) || r.from < cursor || r.to <= r.from || r.to > points.length || points.slice(r.from, r.to).join("") !== r.text || !r.text.trim()) invalid("번역 묶음 범위가 전문과 일치하지 않습니다");
    const gap = points.slice(cursor, r.from).join("");
    if (gap && !/^\s+$/u.test(gap)) invalid("번역 묶음에서 본문이 누락되었습니다");
    add(gap, null);
    // Whitespace is editable document content, never separator metadata on a group.
    for (const line of r.text.split(/(\r\n|\r|\n)/u)) {
      if (!line) continue;
      if (/^\s+$/u.test(line)) add(line, null);
      else {
        const leading = line.match(/^\s*/u)![0], trailing = line.match(/\s*$/u)![0];
        add(leading, null); add(line.slice(leading.length, line.length - trailing.length), r.id); add(trailing, null);
      }
    }
    cursor = r.to;
  }
  const tail = points.slice(cursor).join("");
  if (tail && !/^\s+$/u.test(tail)) invalid("번역 묶음에서 본문이 누락되었습니다");
  add(tail, null);
  // Coalesce adjacent whitespace so a paragraph break is one editable node.
  const compact: typeof tokens = [];
  for (const token of tokens) {
    const last = compact.at(-1);
    if (last?.kind === "whitespace" && token.kind === "whitespace") last.content += token.content;
    else compact.push({ ...token });
  }
  const oldSlots = slots(base.parts), newSlots = slots(compact);
  const oldBySlot = new Map(oldSlots.map((slot, i) => [slot, base.parts[i]!]));
  const parts: ContentPart[] = compact.map((token, index) => {
    const old = oldBySlot.get(newSlots[index]!);
    return { ...token, id: old?.id ?? (seed ? sha256Hex(`${seed}:part:${index}`) : createId()), orderKey: old?.orderKey ?? "", revision: old ? old.revision + (old.content === token.content ? 0 : 1) : 1 };
  });
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.orderKey) p.orderKey = between(parts[i - 1]?.orderKey, parts.slice(i + 1).find(p => p.orderKey)?.orderKey);
    if (i && compareOrder(parts[i - 1]!, p) >= 0) invalid("번역 묶음 순서가 올바르지 않습니다");
  }
  const oldLayout = projectContent(base, { state: "pending", error: null });
  const groups = ranges.map(r => {
    const old = base.groups.find(g => g.id === r.id);
    const unchanged = old && oldLayout.sentences.find(s => s.id === old.sentenceId)?.text === r.text.trim() && same(old.spans, r.spans);
    return { id: r.id, sentenceId: old?.sentenceId ?? r.sentenceId ?? r.id, revision: old ? old.revision + (unchanged ? 0 : 1) : 1, spans: r.spans,
      needsReview: r.needsReview ?? (unchanged ? old!.needsReview : true),
      ...(r.reviewedBy ? { reviewedBy: r.reviewedBy } : unchanged && old?.reviewedBy ? { reviewedBy: old.reviewedBy } : {}) };
  });
  const state = { groups, parts };
  projectContent(state, { state: "pending", error: null });
  if (contentText(state) !== text) invalid("번역 내용 변환 중 문자가 누락되었습니다");
  return state;
}
export function legacyContent(versionId: string, text: string, layout: TextLayout): TranslationContent {
  const sentences = groupedTextSentences(text, layout.sentences, layout.links);
  return buildContent(text, sentences.map(s => {
    const link = layout.links.find(l => l.sentenceId === s.id);
    return { ...s, id: link?.groupId ?? s.id, sentenceId: s.id, spans: link?.spans ?? [], needsReview: link?.needsReview ?? true, reviewedBy: link?.reviewedBy };
  }), undefined, versionId);
}
/** Three-way entity merge. Unchanged groups in an older editor never overwrite newer ones. */
export function mergeContent(base: TranslationContent, edited: TranslationContent, current: TranslationContent): TranslationContent {
  function merge<T extends { id: string }>(before: T[], after: T[], now: T[]): T[] {
    const result = new Map(now.map(x => [x.id, x]));
    for (const id of new Set([...before, ...after].map(x => x.id))) {
      const b = before.find(x => x.id === id), a = after.find(x => x.id === id);
      if (same(b, a)) continue;
      if (!same(b, result.get(id))) conflict();
      if (a) result.set(id, a); else result.delete(id);
    }
    return [...result.values()];
  }
  const result = { groups: merge(base.groups, edited.groups, current.groups), parts: merge(base.parts, edited.parts, current.parts).sort(compareOrder) };
  for (let i = 1; i < result.parts.length; i++) {
    const [an, ad] = fraction(result.parts[i - 1]!.orderKey), [bn, bd] = fraction(result.parts[i]!.orderKey);
    if (an * bd === bn * ad) conflict(); // Competing insertions at the same previously empty boundary.
  }
  projectContent(result, { state: "pending", error: null });
  return result;
}
export function loadContent(db: SqliteDb, versionId: string): TranslationContent | null {
  const snapshot = orm(db).select().from(t.translation_content_snapshots).where(eq(t.translation_content_snapshots.version_id, versionId)).get();
  if (!snapshot) return null;
  const groupIds = JSON.parse(snapshot.group_revisions_json) as string[], partIds = JSON.parse(snapshot.part_revisions_json) as string[];
  const ids = [...groupIds, ...partIds];
  const values = new Map<string, string>();
  // Stay under SQLite's bind parameter limit for long documents.
  for (let i = 0; i < ids.length; i += 500) {
    for (const row of orm(db).select().from(t.translation_content_revisions).where(inArray(t.translation_content_revisions.id, ids.slice(i, i + 500))).all()) values.set(row.id, row.value_json);
  }
  const read = <T>(id: string): T => JSON.parse(values.get(id) ?? invalid("번역 내용 이력이 누락되었습니다"));
  return { groups: groupIds.map(id => read<ContentGroup>(id)), parts: partIds.map(id => read<ContentPart>(id)) };
}
const groupRowId = (translationId: string, key: string) => sha256Hex(`${translationId}:group:${key}`);
/** Write only changed current entities, append their revisions, and reference them from a checkpoint. */
export function storeContent(db: SqliteDb, translationId: string, sourceVersionId: string, versionId: string, state: TranslationContent, previous?: TranslationContent): void {
  const old = previous ?? { groups: [], parts: [] };
  if (!previous) {
    // A legacy whole-text save or fresh AI draft may have replaced the active document.
    // Retire only entities no longer present; immutable revisions stay available to history.
    for (const row of orm(db).select().from(t.translation_content_parts).where(eq(t.translation_content_parts.document_translation_id, translationId)).all()) {
      if (!row.deleted_at && !state.parts.some(p => p.id === row.id)) orm(db).update(t.translation_content_parts).set({ deleted_at: versionId }).where(eq(t.translation_content_parts.id, row.id)).run();
    }
    for (const row of orm(db).select().from(t.translation_groups).where(eq(t.translation_groups.document_translation_id, translationId)).all()) {
      if (!row.deleted_at && !state.groups.some(g => g.id === row.group_key)) orm(db).update(t.translation_groups).set({ deleted_at: versionId }).where(eq(t.translation_groups.id, row.id)).run();
    }
  }
  const revisionIds = { groups: [] as string[], parts: [] as string[] };
  for (const kind of ["group", "part"] as const) {
    const rows = kind === "group" ? state.groups : state.parts;
    const prior = kind === "group" ? old.groups : old.parts;
    for (const value of rows) {
      const entityId = kind === "group" ? groupRowId(translationId, value.id) : value.id;
      if (same(prior.find(p => p.id === value.id), value)) {
        revisionIds[kind === "group" ? "groups" : "parts"].push(sha256Hex(`${translationId}:${kind}:${entityId}:${value.revision}`));
        continue;
      }
      if (!previous && kind === "group") {
        const currentRow = orm(db).select().from(t.translation_groups).where(eq(t.translation_groups.id, entityId)).get();
        if (currentRow) value.revision = currentRow.revision + 1;
      }
      const existing = orm(db).select().from(t.translation_content_revisions).where(and(eq(t.translation_content_revisions.document_translation_id, translationId), eq(t.translation_content_revisions.entity_kind, kind), eq(t.translation_content_revisions.entity_id, entityId), eq(t.translation_content_revisions.revision, value.revision))).get();
      // Alignment can replace metadata on an existing version; revisions remain immutable.
      if (existing && existing.value_json !== canonicalJson(value)) {
        const latest = orm(db).select().from(t.translation_content_revisions).where(and(eq(t.translation_content_revisions.document_translation_id, translationId), eq(t.translation_content_revisions.entity_kind, kind), eq(t.translation_content_revisions.entity_id, entityId))).all();
        value.revision = Math.max(...latest.map(r => r.revision)) + 1;
      }
      const unchanged = prior.find(p => p.id === value.id);
      if (!same(unchanged, value)) {
        if (kind === "group") {
          const g = value as ContentGroup;
          const row = { id: entityId, document_translation_id: translationId, group_key: g.id, sentence_id: g.sentenceId, revision: g.revision, needs_review: Number(g.needsReview), reviewed_by: g.reviewedBy ?? null, deleted_at: null };
          orm(db).insert(t.translation_groups).values(row).onConflictDoUpdate({ target: t.translation_groups.id, set: row }).run();
          const link = { group_id: entityId, source_version_id: sourceVersionId, spans_json: canonicalJson(g.spans) };
          const oldLink = orm(db).select().from(t.translation_group_source_links).where(eq(t.translation_group_source_links.group_id, entityId)).get();
          if (!same(oldLink, link)) orm(db).insert(t.translation_group_source_links).values(link).onConflictDoUpdate({ target: t.translation_group_source_links.group_id, set: link }).run();
        } else {
          const p = value as ContentPart;
          const row = { id: p.id, document_translation_id: translationId, group_id: p.groupId ? groupRowId(translationId, p.groupId) : null, part_kind: p.kind, order_key: p.orderKey, content: p.content, revision: p.revision, deleted_at: null };
          orm(db).insert(t.translation_content_parts).values(row).onConflictDoUpdate({ target: t.translation_content_parts.id, set: row }).run();
        }
      }
      const revId = sha256Hex(`${translationId}:${kind}:${entityId}:${value.revision}`);
      orm(db).insert(t.translation_content_revisions).values({ id: revId, document_translation_id: translationId, entity_id: entityId, entity_kind: kind, revision: value.revision, value_json: canonicalJson(value) }).onConflictDoNothing().run();
      revisionIds[kind === "group" ? "groups" : "parts"].push(revId);
    }
    for (const removed of prior.filter(p => !rows.some(r => r.id === p.id))) {
      if (kind === "group") orm(db).update(t.translation_groups).set({ deleted_at: versionId }).where(eq(t.translation_groups.id, groupRowId(translationId, removed.id))).run();
      else orm(db).update(t.translation_content_parts).set({ deleted_at: versionId }).where(eq(t.translation_content_parts.id, removed.id)).run();
    }
  }
  const snapshot = { version_id: versionId, group_revisions_json: canonicalJson(revisionIds.groups), part_revisions_json: canonicalJson(revisionIds.parts) };
  orm(db).insert(t.translation_content_snapshots).values(snapshot).onConflictDoUpdate({ target: t.translation_content_snapshots.version_id, set: snapshot }).run();
}
