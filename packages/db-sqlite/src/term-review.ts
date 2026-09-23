import { createId, nowIso, MunhaeError } from "@munhae/domain";
import type { SqliteDb } from "./sqlite.ts";

export const TERM_KINDS = ["person", "place", "office", "institution", "work", "object", "concept", "allusion", "expression"] as const;
export type TermContent = {
  sourceForm: string; kind: typeof TERM_KINDS[number]; reading: string | null;
  translation: string | null; definition: string | null; contextNote: string | null;
  selectionReason: string | null; uncertainty: string | null;
  evidence: { citation: string; url: string | null }[];
};
export type TermOccurrence = { quote: string; start: number; end: number };
export type TermEntry = TermContent & {
  id: string; projectId: string; documentId: string | null; parentTermId: string | null;
  status: "draft" | "reviewed" | "excluded"; origin: "manual" | "ai";
  sourceVersion: string | null; occurrences: TermOccurrence[];
  generation: { runId: string; model: string; agentId: string } | null;
  lockVersion: number; createdAt: string; updatedAt: string; archivedAt?: string;
};
export type SaveTermInput = TermContent & {
  id?: string; expectedLockVersion?: number; documentId: string | null;
  parentTermId?: string | null; status: TermEntry["status"];
  sourceVersion?: string | null; quotes?: string[];
};
export function validateTermContent(value: unknown): TermContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MunhaeError("invalid_input", "용어 형식을 확인하세요.");
  const v = value as Record<string, unknown>;
  const text = (key: string, max: number, required = false): string | null => {
    const s = v[key];
    if ((s == null || s === "") && !required) return null;
    if (typeof s !== "string" || !s.trim() || s.length > max) throw new MunhaeError("invalid_input", `용어의 ${key} 값을 확인하세요.`);
    return s.trim();
  };
  if (!TERM_KINDS.includes(v.kind as TermContent["kind"])) throw new MunhaeError("invalid_input", "용어 분류를 확인하세요.");
  if (!Array.isArray(v.evidence) || v.evidence.length > 20) throw new MunhaeError("invalid_input", "용어 근거를 확인하세요.");
  const evidence = v.evidence.map((e: unknown) => {
    const r = e as Record<string, unknown>;
    if (!r || typeof r.citation !== "string" || r.citation.length > 4000 || (r.url != null && (typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || r.url.length > 4000))) throw new MunhaeError("invalid_input", "근거의 설명과 주소를 확인하세요.");
    return { citation: r.citation, url: r.url as string | null ?? null };
  });
  return { sourceForm: text("sourceForm", 300, true)!, kind: v.kind as TermContent["kind"], reading: text("reading", 300), translation: text("translation", 1000), definition: text("definition", 5000), contextNote: text("contextNote", 5000), selectionReason: text("selectionReason", 2000), uncertainty: text("uncertainty", 3000), evidence };
}
export function termOccurrences(source: string, form: string, quotes: string[]): TermOccurrence[] {
  // Offsets use JavaScript UTF-16 code units, never model-generated offsets.
  const found: TermOccurrence[] = [];
  for (const quote of [...new Set(quotes)]) {
    if (!quote.includes(form)) throw new MunhaeError("invalid_input", "등장 구절에 원문 표현이 없습니다.");
    let q = source.indexOf(quote);
    if (q < 0) throw new MunhaeError("invalid_input", "등장 구절이 현재 원문과 일치하지 않습니다.");
    while (q >= 0) {
      let i = quote.indexOf(form);
      while (i >= 0) {
        const start = q + i;
        if (!found.some(o => o.start === start)) found.push({ quote, start, end: start + form.length });
        i = quote.indexOf(form, i + form.length);
      }
      q = source.indexOf(quote, q + quote.length);
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
type Row = { payload_json: string };
export function listTerms(db: SqliteDb, projectId: string, documentId?: string): TermEntry[] {
  const rows = documentId === undefined
    ? db.prepare("SELECT payload_json FROM term_entries WHERE project_id=? ORDER BY created_at,id").all(projectId)
    : db.prepare("SELECT payload_json FROM term_entries WHERE project_id=? AND (document_node_id=? OR document_node_id IS NULL) ORDER BY created_at,id").all(projectId, documentId);
  return (rows as Row[]).map(r => JSON.parse(r.payload_json) as TermEntry).filter(entry => !entry.archivedAt);
}
export function saveTerm(db: SqliteDb, projectId: string, value: SaveTermInput, source?: { version: string; text: string }, generation: TermEntry["generation"] = null): TermEntry {
  const content = validateTermContent(value);
  if (!value || !["draft", "reviewed", "excluded"].includes(value.status) || (value.documentId !== null && typeof value.documentId !== "string")) throw new MunhaeError("invalid_input", "용어 범위와 검토 상태를 확인하세요.");
  return db.transaction(() => {
    const current = value.id ? listTerms(db, projectId).find(t => t.id === value.id) : null;
    if (value.id && !current) throw new MunhaeError("not_found", "용어를 찾을 수 없습니다.");
    if (current && current.lockVersion !== value.expectedLockVersion) throw new MunhaeError("conflict", "용어가 다른 화면에서 변경되었습니다. 다시 불러오세요.");
    if (current && current.documentId !== value.documentId) throw new MunhaeError("invalid_input", "범위를 바꾸려면 공통 항목으로 복사하세요.");
    if (value.documentId !== null) {
      if (!db.prepare("SELECT id FROM document_nodes WHERE id=? AND project_id=? AND archived_at IS NULL").get(value.documentId, projectId)) throw new MunhaeError("not_found", "문서를 찾을 수 없습니다.");
      if (!source || value.sourceVersion !== source.version) throw new MunhaeError("conflict", "원문 또는 표점이 변경되었습니다. 현재 기준 본문에서 용어를 다시 확인하세요.");
    }
    const parent = value.parentTermId ? listTerms(db, projectId).find(t => t.id === value.parentTermId) : null;
    if (value.parentTermId && (!parent || parent.documentId !== null || value.documentId === null || parent.id === value.id)) throw new MunhaeError("invalid_input", "공통 용어 연결을 확인하세요.");
    const quotes = value.quotes ?? [];
    if (!Array.isArray(quotes) || quotes.length > 100 || quotes.some(q => typeof q !== "string" || !q || q.length > 10000)) throw new MunhaeError("invalid_input", "등장 구절을 확인하세요.");
    if (value.documentId && quotes.length === 0) throw new MunhaeError("invalid_input", "원문에서 등장 구절을 입력하세요.");
    const now = nowIso();
    const entry: TermEntry = { ...content, id: current?.id ?? createId(), projectId, documentId: value.documentId, parentTermId: value.parentTermId ?? null, status: value.status, origin: current?.origin ?? (generation ? "ai" : "manual"), sourceVersion: value.documentId ? source!.version : null,
      occurrences: value.documentId ? termOccurrences(source!.text, content.sourceForm, quotes) : [], generation: current?.generation ?? generation,
      lockVersion: (current?.lockVersion ?? 0) + 1, createdAt: current?.createdAt ?? now, updatedAt: now };
    const payload = JSON.stringify(entry);
    db.prepare(`INSERT INTO term_entries(id,project_id,document_node_id,parent_term_id,payload_json,lock_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET parent_term_id=excluded.parent_term_id,payload_json=excluded.payload_json,lock_version=excluded.lock_version,updated_at=excluded.updated_at`).run(entry.id,projectId,entry.documentId,entry.parentTermId,payload,entry.lockVersion,entry.createdAt,now);
    db.prepare("INSERT INTO term_revisions(id,term_id,payload_json,created_at) VALUES(?,?,?,?)").run(createId(),entry.id,payload,now);
    return entry;
  })();
}
export function termsForTranslation(db: SqliteDb, projectId: string, documentId: string, version: string, source: string): TermEntry[] {
  const terms = listTerms(db, projectId, documentId);
  const local = terms.filter(t => t.documentId === documentId && t.sourceVersion === version);
  const overrides = new Set(local.filter(t => t.status !== "draft").map(t => t.parentTermId).filter(Boolean));
  return terms.filter(t => t.status === "reviewed" && (t.documentId ? t.sourceVersion === version : !overrides.has(t.id) && source.includes(t.sourceForm)));
}

export function deleteDocumentTerm(db: SqliteDb, projectId: string, input: { id: string; expectedLockVersion: number }): void {
  if (!input || typeof input.id !== "string" || !Number.isSafeInteger(input.expectedLockVersion) || input.expectedLockVersion < 1) throw new MunhaeError("invalid_input", "삭제할 용어를 확인하세요.");
  db.transaction(() => {
    const current = listTerms(db, projectId).find(term => term.id === input.id);
    if (!current) throw new MunhaeError("not_found", "용어를 찾을 수 없습니다.");
    if (!current.documentId) throw new MunhaeError("invalid_scope", "이 기능은 문서 용어만 삭제할 수 있습니다.");
    if (current.lockVersion !== input.expectedLockVersion) throw new MunhaeError("conflict", "용어가 다른 화면에서 변경되었습니다. 다시 불러오세요.");
    const now = nowIso();
    const payload = JSON.stringify({ ...current, archivedAt: now, updatedAt: now, lockVersion: current.lockVersion + 1 });
    const result = db.prepare("UPDATE term_entries SET payload_json=?,lock_version=lock_version+1,updated_at=? WHERE id=? AND project_id=? AND lock_version=?").run(payload, now, current.id, projectId, input.expectedLockVersion);
    if (result.changes !== 1) throw new MunhaeError("conflict", "용어가 변경되었습니다. 다시 불러오세요.");
    db.prepare("INSERT INTO term_revisions(id,term_id,payload_json,created_at) VALUES(?,?,?,?)").run(createId(),current.id,payload,now);
  })();
}
