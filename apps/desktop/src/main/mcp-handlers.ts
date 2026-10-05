import type { EditorView, ProjectRepo, TermBasis, TermCandidateInput, TermContent, TermRowsSnapshot } from "@munhae/db-sqlite";
import { groupedTextSentences, replaceTextSentence } from "@munhae/domain/text-sentences";
import { MCP_TERM_CONFIDENCE, MCP_TERM_KINDS } from "../shared/mcp-tools";
import { activeAiDocuments } from "./ai-runs";
import { editingDocument, recordMcpChange, undoMcpChange } from "./mcp-changes";
import { McpToolError, type McpSession } from "./mcp-server";
import { getAppConfig, getCurrentSummary, requireRepo, withOnlineProjectSave } from "./session";

type Args = Record<string, unknown>;

const points = (text: string): string[] => Array.from(text);
const clip = (text: string | null | undefined, max = 200): string | null => {
  if (!text) return null;
  const chars = points(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
};

function stringArg(args: Args, key: string, required = true, max = 200): string | undefined {
  const value = args[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new McpToolError("invalid_input", `${key} 값을 확인하세요.`);
  }
  return value.trim();
}

function textArg(value: unknown, key: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) throw new McpToolError("invalid_input", `${key} 값을 확인하세요.`);
  return value.trim() || null;
}

function arrayArg(args: Args, key: string, max: number): unknown[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new McpToolError("invalid_input", `${key}는 1개에서 ${max}개 사이의 목록이어야 합니다.`);
  return value;
}

const record = (value: unknown, key: string): Args => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpToolError("invalid_input", `${key} 항목은 객체여야 합니다.`);
  return value as Args;
};

function kindArg(value: unknown): TermContent["kind"] | undefined {
  if (value === undefined) return undefined;
  if (!(MCP_TERM_KINDS as readonly unknown[]).includes(value)) throw new McpToolError("invalid_input", `kind는 ${MCP_TERM_KINDS.join(", ")} 중 하나입니다.`);
  return value as TermContent["kind"];
}

function confidenceArg(value: unknown): TermCandidateInput["confidence"] | undefined {
  if (value === undefined) return undefined;
  if (!(MCP_TERM_CONFIDENCE as readonly unknown[]).includes(value)) throw new McpToolError("invalid_input", `confidence는 ${MCP_TERM_CONFIDENCE.join(", ")} 중 하나입니다.`);
  return value as TermCandidateInput["confidence"];
}

function alternativesArg(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) throw new McpToolError("invalid_input", "alternatives는 3개 이하의 문자열 목록입니다.");
  return value.map(item => textArg(item, "alternatives", 300)).filter((item): item is string => typeof item === "string");
}

/** Every tool names the project it expects, so a project switch in the app never redirects an edit. */
function openRepo(args: Args): ProjectRepo {
  const summary = getCurrentSummary();
  if (!summary) throw new McpToolError("no_project", "문해에 열린 프로젝트가 없습니다. 사용자에게 프로젝트를 열어 달라고 요청하세요.", true);
  const expected = stringArg(args, "projectId");
  if (expected !== summary.projectId) {
    throw new McpToolError("project_changed", `문해에서 열린 프로젝트가 바뀌었습니다(지금: ${summary.title}). 사용자에게 어느 프로젝트에서 작업할지 확인하세요.`, true);
  }
  return requireRepo();
}

function openProject(): unknown {
  const summary = getCurrentSummary();
  if (!summary) throw new McpToolError("no_project", "문해에 열린 프로젝트가 없습니다. 사용자에게 프로젝트를 열어 달라고 요청하세요.", true);
  const home = requireRepo().getHome();
  return {
    projectId: summary.projectId,
    title: summary.title,
    translationLanguage: getAppConfig().translationLanguage,
    progress: home.progress,
    documents: home.documents.map(doc => ({
      id: doc.id,
      parentId: doc.parentId,
      kind: doc.nodeRole,
      title: doc.title,
      originalTitle: doc.originalTitle,
      source: doc.sourceState,
      punctuation: doc.punctuationState,
      translation: doc.translationState,
    })),
  };
}

/** Sentences as the editor shows them: sentences linked as one group form one row. */
function sentenceRows(translation: NonNullable<EditorView["translation"]>) {
  const layout = translation.textLayout;
  if (!layout) return [];
  const rows = groupedTextSentences(translation.textContent, layout.sentences, layout.links);
  return rows.map(row => ({ row, link: layout.links.find(link => link.sentenceId === row.id) }));
}

const revisionOf = (translation: NonNullable<EditorView["translation"]>): string =>
  `${translation.versionId}:${translation.textLayout?.storageRevision ?? translation.lockVersion}`;

function documentView(repo: ProjectRepo, documentId: string): unknown {
  const editor = repo.getEditor(documentId);
  const translation = editor.translation;
  return {
    document: {
      id: editor.document.id,
      title: editor.document.title,
      originalTitle: editor.document.originalTitle,
      author: editor.document.authorName,
      period: editor.document.periodText,
      date: editor.document.dateText,
      sourceReference: editor.document.sourceReference,
    },
    source: { state: editor.source.state, text: editor.source.contentText },
    punctuation: editor.punctuation ? { state: editor.punctuation.state, text: editor.punctuation.punctuatedText } : null,
    translation: translation ? {
      state: translation.state,
      /** Pass back to write tools; a different value means the translation changed since. */
      revision: revisionOf(translation),
      /** False when the source or punctuation changed after this translation was made. */
      matchesCurrentSource: translation.isCurrentDependencies,
      text: translation.textContent,
      alignment: translation.textLayout?.state ?? null,
      sentences: sentenceRows(translation).map(({ row, link }) => ({
        id: row.id,
        text: row.text,
        source: link?.spans.length ? link.spans.map(span => span.quote).join(" … ") : null,
        needsReview: link?.needsReview ?? false,
      })),
      footnotes: translation.notes?.map(note => ({ number: note.ordinal, kind: note.kind, quote: note.targetQuote, body: note.bodyMd })) ?? [],
    } : null,
  };
}

function termsView(repo: ProjectRepo, documentId: string): unknown {
  const view = repo.getDocumentTerms(documentId);
  const basis = view.basis;
  if (!basis) {
    return { documentId, ready: false, message: "이 문서는 표점을 확정해야 용어를 다룰 수 있습니다.", candidates: [], terms: [] };
  }
  const text = points(basis.text);
  // The sentence around a term's first place is enough for the model to judge the reading.
  const example = (occurrences: Array<{ from: number; to: number }>): string | null => {
    const first = occurrences[0];
    if (!first) return null;
    const sentence = basis.sentences.find(range => range.from <= first.from && first.to <= range.to);
    return sentence ? clip(text.slice(sentence.from, sentence.to).join(""), 120) : null;
  };
  return {
    documentId,
    ready: true,
    punctuationVersion: basis.versionNo,
    candidates: view.candidates.map(candidate => ({
      id: candidate.id,
      sourceForm: candidate.sourceForm,
      kind: candidate.kind,
      reading: candidate.reading,
      translation: candidate.translation,
      definition: candidate.definition,
      contextNote: candidate.contextNote,
      confidence: candidate.confidence,
      alternatives: candidate.alternatives,
      occurrences: candidate.occurrences.length,
      example: example(candidate.occurrences),
      existingTermId: candidate.suggestedTermId,
    })),
    terms: view.terms.map(link => ({
      id: link.id,
      termId: link.term.id,
      sourceForm: link.term.sourceForm,
      kind: link.term.kind,
      reading: link.term.reading,
      translation: link.term.translation,
      definition: link.term.definition,
      contextNote: link.contextNote,
      confidence: link.confidence,
      alternatives: link.alternatives,
      occurrences: link.occurrences.length,
      lockVersion: link.term.lockVersion,
      documentLockVersion: link.lockVersion,
    })),
  };
}

function translationGuide(repo: ProjectRepo, documentId: string): unknown {
  const preview = repo.previewContext({ documentNodeId: documentId });
  // The source is in get_document, and the submission schema belongs to the app's own runs.
  const omit = new Set(["source", "output_contract"]);
  return {
    documentId,
    sections: [
      ...preview.required.filter(item => !omit.has(item.kind)).map(item => ({ label: item.label, content: item.content })),
      ...preview.auxiliary.filter(item => item.included).map(item => ({ label: item.label, content: item.content })),
    ],
  };
}

/* ---------- writes ---------- */

/** Refuses edits that would collide with the app's own AI work or with unsaved edits in the editor. */
function guardWrite(repo: ProjectRepo, documentId: string): void {
  const busy = activeAiDocuments(repo.projectId);
  if (busy.all || busy.documentIds.has(documentId)) {
    throw new McpToolError("document_busy", "문해에서 이 문서의 AI 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.", true);
  }
  if (editingDocument() === documentId) {
    throw new McpToolError("document_editing", "사용자가 문해에서 이 문서를 고치는 중이고 아직 저장하지 않았습니다. 사용자에게 저장한 뒤 다시 요청해 달라고 알리세요.", true);
  }
}

async function write(
  repo: ProjectRepo,
  session: McpSession,
  documentId: string,
  scopes: string[],
  run: () => { result: Record<string, unknown>; summary: string; undo(): void },
): Promise<unknown> {
  guardWrite(repo, documentId);
  const done = await withOnlineProjectSave(run);
  const change = recordMcpChange({
    projectId: repo.projectId, documentId, sessionId: session.id, label: session.label,
    summary: done.summary, scopes, undo: done.undo,
  });
  return { ...done.result, changeId: change.id, summary: done.summary };
}

function editableTranslation(repo: ProjectRepo, documentId: string, revision: string | undefined): NonNullable<EditorView["translation"]> {
  const translation = repo.getEditor(documentId).translation;
  if (!translation) throw new McpToolError("not_found", "이 문서에는 번역안이 없습니다.");
  if (revision !== revisionOf(translation)) {
    throw new McpToolError("stale_revision", "번역이 그사이 바뀌었습니다. get_document로 다시 읽은 뒤 새 revision으로 요청하세요.");
  }
  if (translation.state !== "draft") {
    throw new McpToolError("translation_confirmed", "확정된 번역입니다. 고치려면 사용자가 문해에서 수정본을 만들어야 합니다. 사용자에게 알리세요.", true);
  }
  return translation;
}

type GroupDraft = { text: string; groups: Array<{ id: string; from: number; to: number; text: string; spans: Array<{ from: number; to: number; quote: string }> }> };

/** The translation in the editor's own save shape, so a later undo can put it back with its source links. */
function groupDraft(translation: NonNullable<EditorView["translation"]>, text = translation.textContent, rows = sentenceRows(translation).map(item => item.row)): GroupDraft {
  const links = translation.textLayout?.links ?? [];
  return {
    text,
    groups: rows.map(row => {
      const link = links.find(item => item.sentenceId === row.id);
      return { id: link?.groupId ?? row.id, from: row.from, to: row.to, text: row.text, spans: link?.spans ?? [] };
    }),
  };
}

function saveGroups(repo: ProjectRepo, documentId: string, base: NonNullable<EditorView["translation"]>, draft: GroupDraft): EditorView {
  const storageRevision = base.textLayout?.storageRevision;
  if (!storageRevision) throw new McpToolError("unsupported", "이 번역은 문장 단위로 저장할 수 없는 형식입니다. 사용자에게 알리세요.", true);
  return repo.saveTranslationDraft({
    documentNodeId: documentId,
    textContent: draft.text,
    textBaseVersionId: base.versionId,
    textBaseRevision: storageRevision,
    textGroups: draft.groups,
    blocks: [],
    expectedLockVersion: base.lockVersion,
  });
}

function editSentences(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const edits = arrayArg(args, "edits", 200).map((item, index) => {
    const edit = record(item, `edits[${index}]`);
    const text = edit.text;
    if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new McpToolError("invalid_input", `edits[${index}].text 값을 확인하세요.`);
    return { sentenceId: stringArg(edit, "sentenceId")!, text };
  });
  return write(repo, session, documentId, ["translation"], () => {
    const before = editableTranslation(repo, documentId, stringArg(args, "revision", true, 400));
    let text = before.textContent;
    let rows = sentenceRows(before).map(item => item.row);
    for (const edit of edits) {
      if (!rows.some(row => row.id === edit.sentenceId)) throw new McpToolError("invalid_input", `문장 ${edit.sentenceId}을(를) 찾을 수 없습니다. get_document의 문장 ID를 쓰세요.`);
      ({ text, sentences: rows } = replaceTextSentence(text, rows, edit.sentenceId, edit.text));
    }
    const restore = groupDraft(before);
    const saved = saveGroups(repo, documentId, before, groupDraft(before, text, rows));
    const after = saved.translation!;
    return {
      result: { revision: revisionOf(after) },
      summary: `번역 ${edits.length}문장을 고쳤습니다`,
      undo: () => { saveGroups(repo, documentId, current(repo, documentId, after), restore); },
    };
  });
}

/** The translation as the undo expects to find it; anything else means someone changed it since. */
function current(repo: ProjectRepo, documentId: string, expected: NonNullable<EditorView["translation"]>): NonNullable<EditorView["translation"]> {
  const now = repo.getEditor(documentId).translation;
  if (!now || revisionOf(now) !== revisionOf(expected)) throw new McpToolError("conflict", "이후에 바뀐 내용이 있어 되돌릴 수 없습니다.");
  return now;
}

/** An empty draft cannot be saved as text; going back to one means starting a fresh empty draft. */
function resetToEmpty(repo: ProjectRepo, documentId: string, after: NonNullable<EditorView["translation"]>): void {
  const now = current(repo, documentId, after);
  repo.resetTranslationDraft({ fullText: true, documentNodeId: documentId, expectedSourceLockVersion: repo.getEditor(documentId).source.lockVersion, expectedPunctuationLockVersion: 0, expectedTranslationLockVersion: now.lockVersion });
}

function replaceTranslation(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const text = args.text;
  if (typeof text !== "string" || !text.trim() || text.length > 400_000) throw new McpToolError("invalid_input", "text 값을 확인하세요.");
  return write(repo, session, documentId, ["translation"], () => {
    const editor = repo.getEditor(documentId);
    if (!editor.translation) {
      const draft = repo.createTranslationDraft({ fullText: true, documentNodeId: documentId, expectedSourceLockVersion: editor.source.lockVersion, expectedPunctuationLockVersion: 0 });
      const saved = repo.saveTranslationDraft({ documentNodeId: documentId, textContent: text, blocks: [], expectedLockVersion: draft.translation!.lockVersion });
      const after = saved.translation!;
      // A document cannot go back to having no translation; undo leaves an empty draft.
      return { result: { revision: revisionOf(after) }, summary: "새 번역안을 썼습니다", undo: () => resetToEmpty(repo, documentId, after) };
    }
    const before = editableTranslation(repo, documentId, stringArg(args, "revision", true, 400));
    const restore = groupDraft(before);
    const saved = repo.saveTranslationDraft({ documentNodeId: documentId, textContent: text, blocks: [], expectedLockVersion: before.lockVersion });
    const after = saved.translation!;
    return {
      result: { revision: revisionOf(after) },
      summary: before.textContent.trim() ? "번역 전문을 바꿨습니다" : "새 번역안을 썼습니다",
      undo: before.textContent.trim()
        ? () => { saveGroups(repo, documentId, current(repo, documentId, after), restore); }
        : () => resetToEmpty(repo, documentId, after),
    };
  });
}

function confirmTranslation(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  return write(repo, session, documentId, ["translation"], () => {
    const translation = editableTranslation(repo, documentId, stringArg(args, "revision", true, 400));
    const before = repo.translationHead(documentId);
    repo.confirmTranslation({ documentNodeId: documentId, expectedLockVersion: translation.lockVersion });
    const after = repo.translationHead(documentId)!;
    return {
      result: { state: "confirmed" },
      summary: "번역을 확정했습니다",
      undo: () => {
        repo.unconfirmTranslation({ documentNodeId: documentId, versionId: after.currentVersionId, previousConfirmedVersionId: before?.confirmedVersionId ?? null, expectedLockVersion: after.lockVersion });
      },
    };
  });
}

function addComment(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const on = args.on;
  if (on !== "source" && on !== "translation") throw new McpToolError("invalid_input", "on은 source 또는 translation입니다.");
  const quote = stringArg(args, "quote", true, 2000)!;
  const body = stringArg(args, "body", true, 10_000)!;
  const occurrence = args.occurrence === undefined ? 1 : args.occurrence;
  if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1) throw new McpToolError("invalid_input", "occurrence는 1 이상의 정수입니다.");
  return write(repo, session, documentId, ["comments"], () => {
    const editor = repo.getEditor(documentId);
    const translation = editor.translation;
    if (!translation) throw new McpToolError("not_found", "코멘트는 번역안이 있는 문서에만 달 수 있습니다.");
    const target = on === "source" ? editor.source.contentText : translation.textContent;
    const haystack = points(target), needle = points(quote);
    let from = -1;
    for (let at = 0, seen = 0; at + needle.length <= haystack.length; at += 1) {
      if (needle.every((char, i) => haystack[at + i] === char) && ++seen === occurrence) { from = at; break; }
    }
    if (from < 0) throw new McpToolError("invalid_input", `${on === "source" ? "원문" : "번역"}에서 "${clip(quote, 40)}"의 ${occurrence}번째 등장을 찾지 못했습니다.`);
    const comment = repo.createReviewComment({
      documentNodeId: documentId,
      translationVersionId: translation.versionId,
      targetKind: on,
      targetVersionId: on === "source" ? editor.source.versionId : translation.versionId,
      codepointFrom: from,
      codepointTo: from + needle.length,
      quote,
      bodyMd: body,
    });
    return {
      result: { commentId: comment.id },
      summary: "코멘트를 달았습니다",
      undo: () => {
        const now = repo.listReviewComments(documentId).find(item => item.id === comment.id);
        if (!now) throw new McpToolError("conflict", "이미 지워진 코멘트입니다.");
        repo.archiveReviewComment({ id: comment.id, expectedLockVersion: now.lockVersion });
      },
    };
  });
}

function requireBasis(repo: ProjectRepo, documentId: string): TermBasis {
  const basis = repo.getDocumentTerms(documentId).basis;
  if (!basis) throw new McpToolError("not_ready", "이 문서는 표점을 확정해야 용어를 다룰 수 있습니다. 사용자에게 알리세요.", true);
  return basis;
}

/** Runs a term edit; on any failure the document's term rows go back to how they were. */
function termWrite(repo: ProjectRepo, session: McpSession, documentId: string, apply: (basis: TermBasis) => { result: Record<string, unknown>; summary: string }): Promise<unknown> {
  return write(repo, session, documentId, ["terms"], () => {
    const basis = requireBasis(repo, documentId);
    const before: TermRowsSnapshot = repo.snapshotTermRows(documentId);
    let done: { result: Record<string, unknown>; summary: string };
    try {
      done = apply(basis);
    } catch (error) {
      // Put back only what a partly applied batch changed; untouched rows keep their lock versions.
      const partial = repo.snapshotTermRows(documentId, before);
      if (JSON.stringify(partial) !== JSON.stringify(before)) repo.restoreTermRows(before, partial);
      throw error;
    }
    const after = repo.snapshotTermRows(documentId, before);
    return { ...done, undo: () => repo.restoreTermRows(before, after) };
  });
}

function occurrencesOf(basis: TermBasis, form: string): Array<{ from: number; to: number }> {
  const text = points(basis.text), needle = points(form);
  const found: Array<{ from: number; to: number }> = [];
  for (let at = 0; needle.length && at + needle.length <= text.length; at += 1) {
    if (needle.every((char, i) => text[at + i] === char)) { found.push({ from: at, to: at + needle.length }); at += needle.length - 1; }
  }
  return found;
}

function proposeTerms(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const terms = arrayArg(args, "terms", 100).map((item, index) => record(item, `terms[${index}]`));
  return termWrite(repo, session, documentId, (basis) => {
    const items: TermCandidateInput[] = terms.map((term, index) => {
      const sourceForm = stringArg(term, "sourceForm", true, 300)!;
      const all = occurrencesOf(basis, sourceForm);
      if (!all.length) throw new McpToolError("invalid_input", `확정 표점본에 "${sourceForm}"이(가) 없습니다.`);
      const picks = term.occurrences === undefined ? null : term.occurrences;
      if (picks !== null && (!Array.isArray(picks) || !picks.every(n => Number.isInteger(n) && n >= 1 && n <= all.length))) {
        throw new McpToolError("invalid_input", `terms[${index}].occurrences는 1부터 ${all.length} 사이의 번호입니다.`);
      }
      const evidence = term.evidence === undefined ? [] : term.evidence;
      if (!Array.isArray(evidence)) throw new McpToolError("invalid_input", `terms[${index}].evidence는 목록이어야 합니다.`);
      return {
        sourceForm,
        kind: kindArg(term.kind) ?? (() => { throw new McpToolError("invalid_input", `terms[${index}].kind가 필요합니다.`); })(),
        reading: textArg(term.reading, "reading", 300) ?? null,
        translation: textArg(term.translation, "translation", 1000) ?? null,
        definition: textArg(term.definition, "definition", 5000) ?? null,
        evidence: evidence.map(entry => ({ citation: String(record(entry, "evidence").citation ?? ""), url: typeof (entry as Args).url === "string" ? (entry as Args).url as string : null })),
        contextNote: textArg(term.contextNote, "contextNote", 5000) ?? null,
        confidence: confidenceArg(term.confidence) ?? "certain",
        alternatives: alternativesArg(term.alternatives) ?? [],
        suggestedTermId: null,
        occurrences: picks === null ? all : (picks as number[]).map(n => all[n - 1]!),
      };
    });
    const existing = new Set(repo.getDocumentTerms(documentId).candidates.map(candidate => candidate.id));
    const stored = repo.storeTermCandidates(documentId, basis.punctuationVersionId, items, { runId: `mcp:${session.id}`, agentId: session.label, model: "mcp" }, true);
    const added = stored.filter(candidate => !existing.has(candidate.id));
    return { result: { candidateIds: added.map(candidate => candidate.id) }, summary: `용어 후보 ${items.length}개를 더했습니다` };
  });
}

function confirmTerms(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const picks = arrayArg(args, "candidates", 500).map((item, index) => record(item, `candidates[${index}]`));
  return termWrite(repo, session, documentId, () => {
    const candidates = repo.getDocumentTerms(documentId).candidates;
    const confirmed = picks.map((pick) => {
      const id = stringArg(pick, "id")!;
      const candidate = candidates.find(item => item.id === id);
      if (!candidate) throw new McpToolError("not_found", `후보 ${id}을(를) 찾을 수 없습니다. get_terms로 다시 확인하세요.`);
      const link = repo.confirmTerm({
        documentId,
        punctuationVersionId: candidate.punctuationVersionId,
        candidateId: candidate.id,
        termId: candidate.suggestedTermId,
        term: {
          sourceForm: candidate.sourceForm,
          kind: kindArg(pick.kind) ?? candidate.kind,
          reading: textArg(pick.reading, "reading", 300) ?? candidate.reading,
          translation: textArg(pick.translation, "translation", 1000) ?? candidate.translation,
          definition: textArg(pick.definition, "definition", 5000) ?? candidate.definition,
          evidence: candidate.evidence,
        },
        contextNote: textArg(pick.contextNote, "contextNote", 5000) ?? candidate.contextNote,
        confidence: confidenceArg(pick.confidence) ?? candidate.confidence,
        alternatives: alternativesArg(pick.alternatives) ?? candidate.alternatives,
        occurrences: candidate.occurrences,
      });
      return { candidateId: id, termId: link.term.id };
    });
    return { result: { confirmed }, summary: `용어 ${confirmed.length}개를 확정했습니다` };
  });
}

function dismissCandidates(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const ids = arrayArg(args, "candidateIds", 500).map((id, index) => {
    if (typeof id !== "string" || !id) throw new McpToolError("invalid_input", `candidateIds[${index}] 값을 확인하세요.`);
    return id;
  });
  return termWrite(repo, session, documentId, () => {
    const known = new Set(repo.getDocumentTerms(documentId).candidates.map(candidate => candidate.id));
    for (const id of ids) {
      if (!known.has(id)) throw new McpToolError("not_found", `후보 ${id}을(를) 찾을 수 없습니다. get_terms로 다시 확인하세요.`);
      repo.dismissTermCandidate({ id });
    }
    return { result: { dismissed: ids.length }, summary: `용어 후보 ${ids.length}개를 버렸습니다` };
  });
}

function updateTerms(repo: ProjectRepo, session: McpSession, args: Args): Promise<unknown> {
  const documentId = stringArg(args, "documentId")!;
  const edits = arrayArg(args, "terms", 200).map((item, index) => record(item, `terms[${index}]`));
  return termWrite(repo, session, documentId, () => {
    const links = repo.getDocumentTerms(documentId).terms;
    for (const edit of edits) {
      const termId = stringArg(edit, "termId")!;
      const term = links.find(link => link.term.id === termId)?.term;
      if (!term) throw new McpToolError("not_found", `이 문서에 확정된 용어 ${termId}이(가) 없습니다.`);
      if (edit.lockVersion !== term.lockVersion) throw new McpToolError("stale_revision", `용어 ${term.sourceForm}이(가) 그사이 바뀌었습니다. get_terms로 다시 읽으세요.`);
      repo.updateTerm({
        id: term.id,
        expectedLockVersion: term.lockVersion,
        kind: kindArg(edit.kind) ?? term.kind,
        reading: textArg(edit.reading, "reading", 300) === undefined ? term.reading : textArg(edit.reading, "reading", 300)!,
        translation: textArg(edit.translation, "translation", 1000) === undefined ? term.translation : textArg(edit.translation, "translation", 1000)!,
        definition: textArg(edit.definition, "definition", 5000) === undefined ? term.definition : textArg(edit.definition, "definition", 5000)!,
        evidence: term.evidence,
      });
    }
    return { result: { updated: edits.length }, summary: `용어 ${edits.length}개를 고쳤습니다` };
  });
}

export async function callMcpTool(name: string, args: Args, session: McpSession): Promise<unknown> {
  if (name === "get_open_project") return openProject();
  const repo = openRepo(args);
  switch (name) {
    case "get_document": return documentView(repo, stringArg(args, "documentId")!);
    case "search_project": {
      const scope = args.scope === undefined ? "all" : args.scope;
      if (scope !== "all" && scope !== "source" && scope !== "translation") throw new McpToolError("invalid_input", "scope는 all, source, translation 중 하나입니다.");
      const limit = args.limit === undefined ? 20 : args.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new McpToolError("invalid_input", "limit는 1에서 50 사이의 정수입니다.");
      const view = repo.search({ query: stringArg(args, "query", true, 500)!, scope, documentNodeId: stringArg(args, "documentId", false) ?? null, limit });
      return {
        query: view.query,
        results: view.results.map(hit => ({
          documentId: hit.documentNodeId,
          documentTitle: hit.documentTitle,
          in: hit.resultKind,
          state: hit.state,
          current: hit.isCurrent,
          snippet: hit.snippet,
        })),
      };
    }
    case "get_terms": return termsView(repo, stringArg(args, "documentId")!);
    case "list_comments": {
      const documentId = stringArg(args, "documentId")!;
      return {
        documentId,
        comments: repo.listReviewComments(documentId).map(comment => ({
          id: comment.id,
          on: comment.targetKind,
          quote: comment.quote,
          body: comment.bodyMd,
          updatedAt: comment.updatedAt,
        })),
      };
    }
    case "get_materials": {
      const documentId = stringArg(args, "documentId")!;
      const view = repo.getMaterials(documentId);
      return {
        documentId,
        materials: (view.resolved ?? []).filter(item => item.included).map(item => ({ title: item.title, content: item.contentMd, why: item.reason })),
      };
    }
    case "get_translation_guide": return translationGuide(repo, stringArg(args, "documentId")!);
    case "edit_translation_sentences": return editSentences(repo, session, args);
    case "replace_translation": return replaceTranslation(repo, session, args);
    case "confirm_translation": return confirmTranslation(repo, session, args);
    case "add_comment": return addComment(repo, session, args);
    case "propose_terms": return proposeTerms(repo, session, args);
    case "confirm_terms": return confirmTerms(repo, session, args);
    case "dismiss_term_candidates": return dismissCandidates(repo, session, args);
    case "update_terms": return updateTerms(repo, session, args);
    case "undo_change": {
      const change = await undoMcpChange(stringArg(args, "changeId")!, session.id);
      return { undone: change.id, summary: `되돌렸습니다: ${change.summary}` };
    }
    default: throw new McpToolError("invalid_input", `알 수 없는 도구입니다: ${name}`);
  }
}
