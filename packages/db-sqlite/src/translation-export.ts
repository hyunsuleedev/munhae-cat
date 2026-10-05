import { MunhaeError, nowIso } from "@munhae/domain";
import { and, eq } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as tables } from "./drizzle-schema.ts";
import { linkedSegments, loadExportDocuments, type ExportDocument, type ExportNode, type LinkedSegment } from "./review-export.ts";
import { validatePunctuationText } from "./source-layer.ts";
import type { SqliteDb } from "./sqlite.ts";
import { renderTranslationDocx } from "./translation-docx.ts";

export type TranslationExportFormat = "docx" | "pdf" | "txt" | "markdown";
export type TranslationExportLayout = "translation" | "bilingual";
export type TranslationExportInput = {
  format: TranslationExportFormat;
  layout: TranslationExportLayout;
  state: "current" | "confirmed";
  documentNodeId?: string | null;
};
type PayloadBase = { extension: "docx" | "pdf" | "txt" | "md"; suggestedBaseName: string; documentCount: number };
export type TranslationExportPayload = PayloadBase & (
  | { format: "docx"; bytes: Uint8Array }
  /** The caller prints this self-contained page; nothing in it loads or runs. */
  | { format: "pdf"; printHtml: string }
  | { format: "txt" | "markdown"; text: string });

export type BilingualRow = { source: string; translation: string };
/** Level 0 is the document title; other levels nest folders above source units. */
export type ExportBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "text"; text: string }
  | { kind: "rows"; rows: BilingualRow[] };
export type TranslationOutline = { title: string; lang: string; generatedAt: string; blocks: ExportBlock[] };

const FORMATS = ["docx", "pdf", "txt", "markdown"] as const;
const LAYOUTS = ["translation", "bilingual"] as const;
const OPENING_PUNCTUATION = /^(?:\p{Ps}|\p{Pi}|[「『【《〈〔〖〘〚])$/u;
const invalid = (): never => { throw new MunhaeError("invalid_export", "내보내기 조건이 올바르지 않습니다"); };

function headingText(node: ExportNode): string {
  const original = node.original_title?.trim();
  return original && original !== node.title.trim() ? `${node.title.trim()}(${original})` : node.title.trim();
}

/** Non-blank lines as code point ranges; a line break between groups is a paragraph break in the editor. */
function lineRanges(points: string[]): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let start = 0;
  const close = (end: number) => {
    let from = start, to = end;
    while (from < to && /\s/u.test(points[from]!)) from++;
    while (to > from && /\s/u.test(points[to - 1]!)) to--;
    if (to > from) ranges.push({ from, to });
  };
  points.forEach((point, index) => { if (point === "\n" || point === "\r") { close(index); start = index + 1; } });
  close(points.length);
  return ranges;
}

function confirmedPunctuation(db: SqliteDb, projectId: string, sourceVersionId: string): string | null {
  return orm(db)
    .select({ text: tables.punctuation_versions.punctuated_text })
    .from(tables.punctuation_heads)
    .innerJoin(tables.punctuation_versions, eq(tables.punctuation_versions.id, tables.punctuation_heads.confirmed_version_id))
    .where(and(eq(tables.punctuation_heads.project_id, projectId), eq(tables.punctuation_versions.source_text_version_id, sourceVersionId)))
    .get()?.text ?? null;
}

/**
 * The readable source: the punctuation the translation used, else the confirmed
 * punctuation of that source version, else the stored source. Links stay in
 * stored source coordinates, so cuts are projected onto the punctuated text.
 */
function sourceView(db: SqliteDb, projectId: string, doc: ExportDocument): { points: string[]; at(cursor: number): number } {
  const raw = Array.from(doc.source);
  const plain = { points: raw, at: (cursor: number) => cursor };
  const punctuated = doc.punctuation ?? confirmedPunctuation(db, projectId, doc.source_version_id);
  if (!punctuated) return plain;
  let boundaries: number[];
  try { boundaries = validatePunctuationText(doc.source, punctuated).sourceBoundaryByPunctuationBoundary; } catch { return plain; }
  const points = Array.from(punctuated);
  return {
    points,
    at(cursor) {
      if (cursor <= 0) return 0;
      if (cursor >= raw.length) return points.length;
      // Last boundary still before the cut keeps closing marks with the preceding text.
      let low = 0, high = boundaries.length - 1;
      while (low < high) { const mid = (low + high + 1) >> 1; if (boundaries[mid]! <= cursor) low = mid; else high = mid - 1; }
      // Inserted opening marks and line breaks introduce the following text.
      while (low > 0 && boundaries[low - 1] === boundaries[low] && (OPENING_PUNCTUATION.test(points[low - 1]!) || /\s/u.test(points[low - 1]!))) low--;
      return low;
    },
  };
}

type Unit = { from: number; to: number; sourceFrom: number | null; sourceTo: number };

function absorb(target: Unit, unit: Unit): void {
  target.to = unit.to;
  if (unit.sourceFrom === null) return;
  target.sourceFrom = target.sourceFrom === null ? unit.sourceFrom : Math.min(target.sourceFrom, unit.sourceFrom);
  target.sourceTo = Math.max(target.sourceTo, unit.sourceTo);
}

/**
 * One row per translation paragraph, paired with the source its sentences are
 * linked to. Paragraphs whose links cross or reorder are merged, and unlinked
 * source stays with the preceding row, so every source character appears once
 * and in order. Without usable links the document is a single row.
 */
export function bilingualRows(translation: string, segments: LinkedSegment[] | null, source: { points: string[]; at(cursor: number): number }, sourceLength: number): BilingualRow[] {
  const whole = [{ source: source.points.join("").trim(), translation: translation.trim() }];
  const points = Array.from(translation);
  const ordered = [...(segments ?? [])].sort((a, b) => a.from - b.from);
  if (!ordered.some(segment => segment.spans.length)) return whole;
  const units: Unit[] = [];
  for (const line of lineRanges(points)) {
    const unit: Unit = { ...line, sourceFrom: null, sourceTo: 0 };
    const previous = units.at(-1);
    // A group that spans a line break (verse, internal breaks) keeps its lines together.
    if (previous && ordered.some(segment => segment.from < previous.to && segment.to > line.from)) absorb(previous, unit);
    else units.push(unit);
  }
  for (const segment of ordered) {
    const unit = units.find(value => segment.from < value.to && segment.to > value.from);
    if (!unit) continue;
    for (const span of segment.spans) absorb(unit, { from: unit.from, to: unit.to, sourceFrom: span.from, sourceTo: span.to });
  }
  const rows: Unit[] = [];
  for (const unit of units) {
    const previous = rows.at(-1);
    if (previous && (unit.sourceFrom === null || previous.sourceFrom === null || unit.sourceFrom < previous.sourceTo)) absorb(previous, unit);
    else rows.push({ ...unit });
    while (rows.length > 1 && rows.at(-1)!.sourceFrom! < rows.at(-2)!.sourceTo) absorb(rows.at(-2)!, rows.pop()!);
  }
  if (rows[0]?.sourceFrom == null) return whole;
  const cuts = [0, ...rows.slice(1).map(row => row.sourceFrom!), sourceLength].map(cursor => source.at(cursor));
  return rows.map((row, index) => ({
    source: source.points.slice(cuts[index], cuts[index + 1]).join("").trim(),
    translation: points.slice(row.from, row.to).join("").trim(),
  }));
}

export function buildTranslationOutline(db: SqliteDb, projectId: string, input: Omit<TranslationExportInput, "format">): TranslationOutline {
  const project = orm(db).select({ title: tables.core_projects.title }).from(tables.core_projects).where(eq(tables.core_projects.id, projectId)).get();
  if (!project) throw new MunhaeError("invalid_project", "프로젝트를 찾을 수 없습니다");
  const documents = loadExportDocuments(db, projectId, { state: input.state, documentNodeId: input.documentNodeId, includeComments: false });
  if (!documents.length) throw new MunhaeError("nothing_to_export", input.state === "confirmed" ? "선택한 범위에 확정된 번역이 없습니다" : "선택한 범위에 저장된 번역이 없습니다");
  const single = input.documentNodeId ? documents[0]! : null;
  const title = single ? headingText(single.node) : project.title.trim();
  const blocks: ExportBlock[] = [{ kind: "heading", level: 0, text: title }];
  let openFolders: string[] = [];
  for (const doc of documents) {
    if (!single) {
      const folders = doc.ancestors.filter(node => node.id !== doc.node.id && !node.is_master);
      const shared = folders.findIndex((node, index) => openFolders[index] !== node.id);
      const from = shared < 0 ? folders.length : shared;
      folders.slice(from).forEach((node, index) => blocks.push({ kind: "heading", level: from + index + 1, text: headingText(node) }));
      openFolders = folders.map(node => node.id);
      const text = headingText(doc.node), previous = blocks.at(-1);
      // A lone source unit often shares the project's (or its folder's) name.
      if (previous?.kind !== "heading" || previous.text !== text) blocks.push({ kind: "heading", level: folders.length + 1, text });
    }
    if (input.layout === "translation") blocks.push({ kind: "text", text: doc.translation.replace(/\r\n?/g, "\n").trim() });
    else {
      const source = sourceView(db, projectId, doc);
      blocks.push({ kind: "rows", rows: bilingualRows(doc.translation, linkedSegments(db, doc), source, Array.from(doc.source).length) });
    }
  }
  return { title, lang: documents[0]!.target_locale || "ko", generatedAt: nowIso(), blocks };
}

export function paragraphs(text: string): string[] {
  return text.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean);
}

export function renderTranslationText(outline: TranslationOutline): string {
  const out: string[] = [];
  for (const block of outline.blocks) {
    if (block.kind === "heading") out.push(block.text, "");
    else if (block.kind === "text") out.push(block.text, "");
    else for (const row of block.rows) out.push(row.source, row.translation, "");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** Escape only what CommonMark would read as markup, so ordinary prose stays readable. */
function markdownLine(line: string): string {
  return line.replace(/[\\`*_[\]<>~|]/g, "\\$&").replace(/^(\d+)([.)])/, "$1\\$2").replace(/^(#{1,6}(?=\s|$)|[-+=])/, "\\$1");
}

export function renderTranslationMarkdown(outline: TranslationOutline): string {
  const out: string[] = [];
  for (const block of outline.blocks) {
    if (block.kind === "heading") out.push(`${"#".repeat(Math.min(block.level + 1, 6))} ${markdownLine(block.text)}`, "");
    else if (block.kind === "text") paragraphs(block.text).forEach(line => out.push(markdownLine(line), ""));
    else for (const row of block.rows) {
      out.push(...paragraphs(row.source).map(line => `> ${markdownLine(line)}`), "");
      paragraphs(row.translation).forEach(line => out.push(markdownLine(line), ""));
    }
  }
  return `${out.join("\n").trim()}\n`;
}

const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const htmlParagraphs = (text: string, className = ""): string => paragraphs(text).map(line => `<p${className ? ` class="${className}"` : ""}>${esc(line)}</p>`).join("");

export function renderTranslationHtml(outline: TranslationOutline): string {
  const body = outline.blocks.map(block => {
    if (block.kind === "heading") {
      const level = Math.min(block.level + 1, 6);
      return `<h${level}>${esc(block.text)}</h${level}>`;
    }
    if (block.kind === "text") return htmlParagraphs(block.text);
    return `<table><colgroup><col><col></colgroup><tbody>${block.rows.map(row => `<tr><td class="source">${htmlParagraphs(row.source)}</td><td>${htmlParagraphs(row.translation)}</td></tr>`).join("")}</tbody></table>`;
  }).join("\n");
  return `<!doctype html>
<html lang="${esc(outline.lang)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(outline.title)}</title><style>
@page{size:A4;margin:22mm 20mm 24mm}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact}
body{margin:0;color:#1f1e1b;font:10.5pt/1.8 "AppleMyungjo","Noto Serif KR","Noto Serif CJK KR","Nanum Myeongjo","Batang",serif;word-break:keep-all;overflow-wrap:anywhere}
h1,h2,h3,h4,h5,h6{font-weight:600;line-height:1.4;break-after:avoid}
h1{font-size:19pt;margin:0 0 14mm}
h2{font-size:15pt;margin:12mm 0 5mm}
h3{font-size:13pt;margin:9mm 0 4mm}
h4,h5,h6{font-size:11.5pt;margin:7mm 0 3mm}
p{margin:0 0 3.2mm;orphans:2;widows:2}
table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 6mm}
td{width:50%;vertical-align:top;padding:3mm 3.5mm;border-top:.5pt solid #c9c4b8;border-bottom:.5pt solid #c9c4b8}
td p:last-child{margin-bottom:0}
.source{font-family:"Noto Serif CJK KR","Source Han Serif K","AppleMyungjo","Songti SC","Batang",serif;font-size:11pt;word-break:normal;border-right:.5pt solid #e3dfd6}
</style></head><body>
${body}
</body></html>
`;
}

function baseName(title: string, layout: TranslationExportLayout): string {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "munhae";
  return `${safe}-${layout === "bilingual" ? "대역" : "번역"}`;
}

export function buildTranslationExport(db: SqliteDb, projectId: string, input: TranslationExportInput): TranslationExportPayload {
  if (!input || !(FORMATS as readonly string[]).includes(input.format) || !(LAYOUTS as readonly string[]).includes(input.layout)
    || !["current", "confirmed"].includes(input.state)
    || (input.documentNodeId != null && (typeof input.documentNodeId !== "string" || !input.documentNodeId.trim()))) invalid();
  const outline = orm(db).transaction(() => buildTranslationOutline(db, projectId, input));
  const documentCount = input.documentNodeId ? 1 : outline.blocks.filter(block => block.kind !== "heading").length;
  const base = { suggestedBaseName: baseName(outline.title, input.layout), documentCount };
  switch (input.format) {
    case "docx": return { ...base, format: "docx", extension: "docx", bytes: renderTranslationDocx(outline) };
    case "pdf": return { ...base, format: "pdf", extension: "pdf", printHtml: renderTranslationHtml(outline) };
    case "txt": return { ...base, format: "txt", extension: "txt", text: renderTranslationText(outline) };
    case "markdown": return { ...base, format: "markdown", extension: "md", text: renderTranslationMarkdown(outline) };
  }
}
