import { loadContent, projectContent } from "./translation-content.ts";
import { MunhaeError, nowIso, sliceCodepoints } from "@munhae/domain";
import { and, eq, isNull } from "drizzle-orm";
import { orm } from "./drizzle-db.ts";
import { schema as tables } from "./drizzle-schema.ts";
import type { SqliteDb } from "./sqlite.ts";

export type ReviewExportInput = {
  format: "html" | "markdown";
  state: "current" | "confirmed";
  documentNodeId?: string | null;
  includeComments?: boolean;
};
export type ReviewExportPayload = {
  format: ReviewExportInput["format"];
  mediaType: string;
  extension: "html" | "md";
  suggestedBaseName: string;
  documentCount: number;
  content: string;
};
export type ExportNode = {
  id: string; parent_node_id: string | null; title: string; original_title: string | null;
  ordinal: number; node_role: string; is_master: number; author_name: string | null; period_text: string | null;
  date_text: string | null; source_reference: string | null;
};
type Translation = {
  document_id: string; version_id: string; version_no: number; state: string; created_at: string; target_locale: string;
  translation: string; source_version_id: string; source_version_no: number; source: string;
  current_source_version_id: string | null; punctuation: string | null;
};
export type Span = { from: number; to: number; quote: string };
/** A stored translation range (code points) and the validated source spans it owns. */
export type LinkedSegment = { from: number; to: number; text: string; spans: Span[]; status: string };
type Pair = { source: string; translation: string; status: string; spans: Span[] };
type Comment = { target_kind: string; quote: string; body_md: string };
export type ExportDocument = Translation & { node: ExportNode; ancestors: ExportNode[]; title: string; path: string; metadata: Array<[string, string]>; pairs: Pair[]; uncovered: string[]; comments: Comment[] };
type Document = ExportDocument;
type Node = ExportNode;
const invalid = (): never => { throw new MunhaeError("invalid_export", "검토본 내보내기 조건이 올바르지 않습니다"); };
const esc = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const md = (value: string): string => esc(value).replace(/[\\`*_{}\[\]()#+.!|~-]/g, "\\$&").replace(/\r\n?|\n/g, "<br>");
function fenced(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return `${fence}text\n${value}\n${fence}`;
}
function validSpan(value: unknown, text: string): value is Span {
  if (!value || typeof value !== "object") return false;
  const span = value as Span;
  return Number.isSafeInteger(span.from) && Number.isSafeInteger(span.to) && span.from >= 0
    && span.to > span.from && typeof span.quote === "string"
    && sliceCodepoints(text, span.from, span.to) === span.quote
    && Array.from(span.quote).length === span.to - span.from;
}
function unlinked(translation: string): Pair[] {
  return [{ source: "", translation, status: "미연결 · 원문 전문과 대조하세요", spans: [] }];
}
function pairsFor(db: SqliteDb, item: Translation): Pair[] {
  const segments = linkedSegments(db, item);
  return segments
    ? segments.map(segment => ({ source: segment.spans.map(span => span.quote).join("\n…\n"), translation: segment.text, status: segment.status, spans: segment.spans }))
    : unlinked(item.translation);
}
/** Null when no correspondence is stored or the stored coordinates no longer match the texts. */
export function linkedSegments(db: SqliteDb, item: Pick<Translation, "version_id" | "translation" | "source">): LinkedSegment[] | null {
  const layout = orm(db)
    .select({
      sentences_json: tables.translation_text_layouts.sentences_json,
      links_json: tables.translation_text_layouts.links_json,
    })
    .from(tables.translation_text_layouts)
    .where(eq(tables.translation_text_layouts.version_id, item.version_id))
    .get();
  if (layout) {
    try {
      const content = loadContent(db, item.version_id);
      const projected = content ? projectContent(content, { state: "ready", error: null }) : null;
      const sentences = projected?.sentences ?? JSON.parse(layout.sentences_json) as unknown;
      const links = projected?.links ?? JSON.parse(layout.links_json) as unknown;
      if (!Array.isArray(sentences) || !Array.isArray(links) || !sentences.length) return null;
      let end = 0;
      const ids = new Set<string>();
      const segments: LinkedSegment[] = [];
      for (const sentence of sentences) {
        if (!sentence || typeof sentence.id !== "string" || ids.has(sentence.id)
          || !validSpan({ from: sentence.from, to: sentence.to, quote: sentence.text }, item.translation)
          || sentence.from < end || sliceCodepoints(item.translation, end, sentence.from).trim()) return null;
        ids.add(sentence.id); end = sentence.to;
        const matches = links.filter(link => link?.sentenceId === sentence.id);
        const link = matches.length === 1 ? matches[0] : null;
        const spans: Span[] = link && Array.isArray(link.spans) && link.spans.length && link.spans.every((span: unknown) => validSpan(span, item.source)) ? link.spans : [];
        segments.push({ from: sentence.from, to: sentence.to, text: sentence.text, spans,
          status: !spans.length ? "미연결" : link.needsReview ? "대응 확인 필요" : link.reviewedBy === "human" ? "사람이 대응 확인" : "자동 연결 · 검토 필요" });
      }
      if (sliceCodepoints(item.translation, end, Array.from(item.translation).length).trim()) return null;
      return segments;
    } catch { return null; }
  }
  // Older projects retain block/anchor correspondence instead of sentence links.
  const blocks = orm(db)
    .select({
      id: tables.translation_blocks.id,
      target_codepoint_from: tables.translation_blocks.target_codepoint_from,
      target_codepoint_to: tables.translation_blocks.target_codepoint_to,
      validation_state: tables.translation_blocks.validation_state,
    })
    .from(tables.translation_blocks)
    .where(
      eq(
        tables.translation_blocks.document_translation_version_id,
        item.version_id,
      ),
    )
    .orderBy(tables.translation_blocks.ordinal)
    .all();
  if (!blocks.length) return null;
  return blocks.map(block => {
    const spans = orm(db)
      .select({
        from: tables.translation_anchors.source_codepoint_from,
        to: tables.translation_anchors.source_codepoint_to,
        quote: tables.translation_anchors.source_quote,
      })
      .from(tables.translation_block_anchors)
      .innerJoin(
        tables.translation_anchors,
        eq(
          tables.translation_anchors.id,
          tables.translation_block_anchors.translation_anchor_id,
        ),
      )
      .where(eq(tables.translation_block_anchors.translation_block_id, block.id))
      .orderBy(tables.translation_block_anchors.ordinal)
      .all();
    const valid = spans.length > 0 && spans.every(span => validSpan(span, item.source));
    return { from: block.target_codepoint_from, to: block.target_codepoint_to,
      text: sliceCodepoints(item.translation, block.target_codepoint_from, block.target_codepoint_to),
      status: valid ? "저장된 블록 연결 · 검토 필요" : "미연결", spans: valid ? spans : [] };
  });
}
function uncoveredSource(source: string, pairs: Pair[]): string[] {
  const intervals = pairs.flatMap(pair => pair.spans).sort((a, b) => a.from - b.from);
  const chars = Array.from(source);
  let end = 0;
  const parts: string[] = [];
  for (const span of intervals) {
    if (span.from > end) parts.push(chars.slice(end, span.from).join(""));
    end = Math.max(end, span.to);
  }
  if (end < chars.length) parts.push(chars.slice(end).join(""));
  return parts.filter(part => /[^\p{P}\p{Z}\s]/u.test(part));
}
export function loadExportDocuments(db: SqliteDb, projectId: string, input: Pick<ReviewExportInput, "state" | "documentNodeId" | "includeComments">): Document[] {
  const nodes = orm(db)
    .select({
      id: tables.document_nodes.id,
      parent_node_id: tables.document_nodes.parent_node_id,
      title: tables.document_nodes.title,
      original_title: tables.document_nodes.original_title,
      ordinal: tables.document_nodes.ordinal,
      node_role: tables.document_nodes.node_role,
      is_master: tables.document_nodes.is_master,
      author_name: tables.document_nodes.author_text,
      period_text: tables.document_nodes.period_text,
      date_text: tables.document_nodes.date_text,
      source_reference: tables.document_nodes.source_reference,
    })
    .from(tables.document_nodes)
    .where(
      and(
        eq(tables.document_nodes.project_id, projectId),
        isNull(tables.document_nodes.archived_at),
      ),
    )
    .orderBy(tables.document_nodes.ordinal, tables.document_nodes.id)
    .all();
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (input.documentNodeId && byId.get(input.documentNodeId)?.node_role !== "source_unit")
    throw new MunhaeError("invalid_document", "내보낼 원문 작업 단위를 찾을 수 없습니다");
  const head = input.state === "confirmed" ? tables.document_translation_heads.confirmed_version_id : tables.document_translation_heads.current_version_id;
  const items = orm(db)
    .select({
      document_id: tables.document_nodes.id,
      version_id: tables.document_translation_versions.id,
      version_no: tables.document_translation_versions.version_no,
      state: tables.document_translation_versions.state,
      created_at: tables.document_translation_versions.created_at,
      target_locale: tables.document_translations.target_locale,
      translation: tables.document_translation_versions.text_content,
      source_version_id: tables.src_text_versions.id,
      source_version_no: tables.src_text_versions.version_no,
      source: tables.src_text_versions.content_text,
      current_source_version_id: tables.src_text_heads.current_version_id,
      punctuation: tables.punctuation_versions.punctuated_text,
    })
    .from(tables.document_translation_heads)
    .innerJoin(
      tables.document_translations,
      eq(
        tables.document_translations.id,
        tables.document_translation_heads.document_translation_id,
      ),
    )
    .innerJoin(
      tables.document_translation_versions,
      eq(tables.document_translation_versions.id, head),
    )
    .innerJoin(
      tables.document_nodes,
      eq(tables.document_nodes.id, tables.document_translations.document_node_id),
    )
    .innerJoin(
      tables.src_text_versions,
      and(
        eq(
          tables.src_text_versions.id,
          tables.document_translation_versions.source_text_version_id,
        ),
        eq(
          tables.src_text_versions.project_id,
          tables.document_translations.project_id,
        ),
      ),
    )
    .leftJoin(
      tables.src_text_heads,
      eq(
        tables.src_text_heads.source_text_id,
        tables.src_text_versions.source_text_id,
      ),
    )
    .leftJoin(
      tables.punctuation_versions,
      and(
        eq(
          tables.punctuation_versions.id,
          tables.document_translation_versions.punctuation_version_id,
        ),
        eq(
          tables.punctuation_versions.source_text_version_id,
          tables.src_text_versions.id,
        ),
      ),
    )
    .where(
      and(
        eq(tables.document_translations.project_id, projectId),
        isNull(tables.document_translations.tombstoned_at),
        isNull(tables.document_nodes.archived_at),
        eq(tables.document_nodes.node_role, "source_unit"),
        input.documentNodeId == null
          ? undefined
          : eq(tables.document_nodes.id, input.documentNodeId),
        input.state === "confirmed"
          ? eq(tables.document_translation_versions.state, "confirmed")
          : undefined,
      ),
    )
    .orderBy(tables.document_nodes.ordinal, tables.document_nodes.id)
    .all();
  const documents = items.filter(item => item.translation.trim()).map(item => {
    const node = byId.get(item.document_id)!;
    const ancestors: Node[] = [];
    const seen = new Set<string>();
    let current: Node | undefined = node;
    while (current && !seen.has(current.id)) { ancestors.unshift(current); seen.add(current.id); current = current.parent_node_id ? byId.get(current.parent_node_id) : undefined; }
    const nearest = (key: "author_name" | "period_text" | "source_reference") => [...ancestors].reverse().find(value => value[key]?.trim())?.[key];
    const metadata = ([ ["저자", nearest("author_name")], ["시대", nearest("period_text")], ["작성 시기", node.date_text], ["문헌 출처", nearest("source_reference")] ] as Array<[string, string | null | undefined]>).filter((entry): entry is [string, string] => !!entry[1]);
    const pairs = pairsFor(db, item);
    const comments = input.includeComments === false ? [] : orm(db)
      .select({
        target_kind: tables.review_comments.target_kind,
        quote: tables.review_comments.quote,
        body_md: tables.review_comments.body_md,
      })
      .from(tables.review_comments)
      .where(
        and(
          eq(tables.review_comments.project_id, projectId),
          eq(tables.review_comments.document_node_id, item.document_id),
          eq(tables.review_comments.translation_version_id, item.version_id),
          isNull(tables.review_comments.archived_at),
        ),
      )
      .orderBy(tables.review_comments.created_at, tables.review_comments.id)
      .all();
    return { ...item, node, ancestors, title: node.original_title || node.title, path: ancestors.map(value => value.original_title || value.title).join(" › "), metadata, pairs, uncovered: uncoveredSource(item.source, pairs), comments };
  });
  // Preserve the project's tree order, including sources under different folders.
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (node: Node) => { if (visited.has(node.id)) return; visited.add(node.id); ordered.push(node.id); nodes.filter(child => child.parent_node_id === node.id).forEach(visit); };
  nodes.filter(node => !node.parent_node_id || !byId.has(node.parent_node_id)).forEach(visit);
  nodes.forEach(visit);
  return documents.sort((a, b) => ordered.indexOf(a.document_id) - ordered.indexOf(b.document_id));
}
function status(item: Document): string {
  return `${item.state === "confirmed" ? "확정본" : "미확정 작업안"} · 번역 v${item.version_no} · 원문 v${item.source_version_no}`;
}
const staleNotice = "현재 원문과 다른 버전에 기초한 번역입니다. 아래 원문은 이 번역에 사용된 당시 원문입니다.";
function htmlText(text: string): string {
  // Only explicit HTTPS/HTTP URLs become links; Markdown/HTML in notes stays text.
  return text.split(/(https?:\/\/[^\s<>"']+)/g).map(part => /^https?:\/\//.test(part)
    ? `<a href="${esc(part)}" rel="noreferrer noopener">${esc(part)}</a>` : esc(part)).join("");
}
function renderHtml(title: string, generatedAt: string, documents: Document[], includeComments: boolean): string {
  return `<!doctype html>\n<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(title)} — 번역 검토본</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f3f0e9;color:#282721;font:15px/1.85 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}main{max-width:1100px;margin:36px auto;padding:46px;background:#fffefa}h1,h2,h3{line-height:1.4}h1{font-size:28px}h2{font-size:24px;margin-top:0}h3{font-size:17px;margin-top:28px}.meta,.hint,.state{color:#67655e;font-size:13px}.document{margin-top:42px;padding-top:30px;border-top:2px solid #d8d2c6}.state{font-weight:600}.notice{padding:10px 14px;background:#fbf0d6;border-left:3px solid #b98830}.metadata{display:grid;grid-template-columns:90px 1fr;gap:5px 12px}.metadata dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.metadata dt{color:#67655e}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{border:1px solid #ddd8cd;vertical-align:top;text-align:left;padding:13px}th{background:#f2eee5;font-size:13px}th:first-child{width:7%}th:nth-child(2){width:42%}.text,td,.quote{white-space:pre-wrap;overflow-wrap:anywhere}.source{font-family:"Songti SC","Noto Serif CJK KR",serif;font-size:17px}.row-state{display:block;margin-top:9px;font-size:11px;color:#756c59;white-space:normal}.missing{color:#8c6630}.comment{padding:14px 0;border-top:1px solid #ddd8cd;break-inside:avoid}.quote{font-weight:600;margin-bottom:8px}a{color:#6a552c;overflow-wrap:anywhere}.full-text{border:1px solid #e4ded2;padding:16px}.hint{margin:6px 0 14px}@media(max-width:700px){main{margin:0;padding:22px}th,td{padding:8px}.metadata{grid-template-columns:70px 1fr}}@media print{@page{size:A4;margin:15mm}body,main{background:white;margin:0;padding:0;max-width:none;font-size:10pt}h1{font-size:20pt}h2{font-size:17pt}.document{break-before:page;border:0;padding:0}.document:first-of-type{break-before:auto}thead{display:table-header-group}tr{break-inside:avoid}h2,h3{break-after:avoid}.source{font-size:11pt}a{color:inherit;text-decoration:none}.hint.screen-only{display:none}}</style></head><body><main>
    <header><h1>${esc(title)} · 번역 검토본</h1><p class="meta">생성 ${esc(generatedAt)} · ${documents.length}개 문서</p><p class="hint screen-only">브라우저의 인쇄 기능에서 종이로 출력하거나 PDF로 저장할 수 있습니다.</p><p class="hint">대응 상태는 원문 연결에 관한 표시입니다. 번역 내용의 정확성은 별도로 검토하세요.</p></header>
    ${documents.map(item => `<section class="document"><p class="meta">${esc(item.path)}</p><h2>${esc(item.title)}</h2><p class="state">${esc(status(item))} · 저장 ${esc(item.created_at)}</p>
      ${item.current_source_version_id !== item.source_version_id ? `<p class="notice">${staleNotice}</p>` : ""}
      ${item.metadata.length ? `<h3>문헌 정보</h3><dl class="metadata">${item.metadata.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${htmlText(value)}</dd>`).join("")}</dl>` : ""}
      <h3>원문·번역 대조</h3><table><thead><tr><th>번호</th><th>원문 구절</th><th>번역문</th></tr></thead><tbody>${item.pairs.map((pair, index) => `<tr><td>${index + 1}</td><td class="source">${pair.source ? esc(pair.source) : '<span class="missing">연결된 원문 없음</span>'}</td><td>${esc(pair.translation)}<span class="row-state">${esc(pair.status)}</span></td></tr>`).join("")}</tbody></table>
      ${item.uncovered.length ? `<h3>대응표에 연결되지 않은 원문</h3><p class="hint">미번역을 단정하는 표시가 아닙니다. 번역 전문과 비교해 대응 여부를 확인하세요.</p>${item.uncovered.map(part => `<p class="text source">${esc(part)}</p>`).join("")}` : ""}
      <h3>원문 전문</h3><div class="full-text text source">${esc(item.source)}</div>${item.punctuation ? `<h3>번역에 사용된 표점 원문</h3><div class="full-text text source">${esc(item.punctuation)}</div>` : ""}
      <h3>번역 전문</h3><div class="full-text text">${esc(item.translation)}</div>
      ${includeComments ? `<h3>검토 코멘트 · ${item.comments.length}개</h3><p class="hint">이 번역 버전에 연결된 검토 의견과 참고자료입니다. 출판용 각주가 아닙니다.</p>${item.comments.length ? item.comments.map((comment, index) => `<article class="comment"><div class="meta">코멘트 ${index + 1} · ${comment.target_kind === "source" ? "원문" : "번역문"}</div><div class="quote">${esc(comment.quote)}</div><div class="text">${htmlText(comment.body_md)}</div></article>`).join("") : '<p class="hint">연결된 코멘트가 없습니다.</p>'}` : ""}
    </section>`).join("\n")}</main></body></html>\n`;
}
function renderMarkdown(title: string, generatedAt: string, documents: Document[], includeComments: boolean): string {
  const out = [`# ${md(title)} · 번역 검토본`, "", `생성 ${md(generatedAt)} · ${documents.length}개 문서`, "", "대응 상태는 원문 연결에 관한 표시입니다. 번역 내용의 정확성은 별도로 검토하세요.", ""];
  for (const item of documents) {
    out.push(`## ${md(item.path)}`, "", status(item), "", `저장 ${md(item.created_at)}`, "");
    if (item.current_source_version_id !== item.source_version_id) out.push(staleNotice, "");
    if (item.metadata.length) out.push("### 문헌 정보", "", ...item.metadata.map(([key, value]) => `- ${key}: ${md(value)}`), "");
    out.push("### 원문·번역 대조", "", "| 번호 | 원문 구절 | 번역문 | 대응 상태 |", "| --- | --- | --- | --- |");
    item.pairs.forEach((pair, index) => out.push(`| ${index + 1} | ${pair.source ? md(pair.source) : "연결된 원문 없음"} | ${md(pair.translation)} | ${pair.status} |`));
    out.push("");
    if (item.uncovered.length) out.push("### 대응표에 연결되지 않은 원문", "", "미번역을 단정하는 표시가 아닙니다. 번역 전문과 비교해 대응 여부를 확인하세요.", "", ...item.uncovered.flatMap(part => [fenced(part), ""]));
    out.push("### 원문 전문", "", fenced(item.source), "");
    if (item.punctuation) out.push("### 번역에 사용된 표점 원문", "", fenced(item.punctuation), "");
    out.push("### 번역 전문", "", fenced(item.translation), "");
    if (includeComments) {
      out.push(`### 검토 코멘트 · ${item.comments.length}개`, "", "이 번역 버전에 연결된 검토 의견과 참고자료입니다. 출판용 각주가 아닙니다.", "");
      item.comments.forEach((comment, index) => out.push(`#### 코멘트 ${index + 1} · ${comment.target_kind === "source" ? "원문" : "번역문"}`, "", fenced(comment.quote), "", fenced(comment.body_md), ""));
      if (!item.comments.length) out.push("연결된 코멘트가 없습니다.", "");
    }
  }
  return `${out.join("\n")}\n`;
}
export function buildReviewExport(db: SqliteDb, projectId: string, input: ReviewExportInput): ReviewExportPayload {
  if (!input || !["html", "markdown"].includes(input.format) || !["current", "confirmed"].includes(input.state)
    || (input.documentNodeId != null && (typeof input.documentNodeId !== "string" || !input.documentNodeId.trim()))
    || (input.includeComments !== undefined && typeof input.includeComments !== "boolean")) invalid();
  return orm(db).transaction((): ReviewExportPayload => {
    const project = orm(db)
      .select({ title: tables.core_projects.title })
      .from(tables.core_projects)
      .where(eq(tables.core_projects.id, projectId))
      .get();
    if (!project) throw new MunhaeError("invalid_project", "프로젝트를 찾을 수 없습니다");
    const documents = loadExportDocuments(db, projectId, input);
    if (!documents.length) throw new MunhaeError("nothing_to_export", input.state === "confirmed" ? "선택한 범위에 확정된 번역이 없습니다" : "선택한 범위에 저장된 번역이 없습니다");
    const includeComments = input.includeComments !== false;
    const generatedAt = nowIso();
    const title = input.documentNodeId ? documents[0]!.title : project.title;
    return { format: input.format, mediaType: input.format === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8",
      extension: input.format === "html" ? "html" : "md", documentCount: documents.length,
      suggestedBaseName: `${title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "munhae"}-검토본`,
      content: input.format === "html" ? renderHtml(title, generatedAt, documents, includeComments) : renderMarkdown(title, generatedAt, documents, includeComments),
    };
  });
}
