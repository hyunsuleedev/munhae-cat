import { renderBookFlow, bookFlowRange, bookGroupCaret, bookGroupSelection, bookGapAtPoint, markBookGap, joinBookGap, type BookEditCard } from "./book-translation-flow";
import { configureSentenceSelection } from "./sentence-selection-ui";
import { createPunctuationProgress } from "./punctuation-progress-ui";
import { configurePunctuationWorkspace } from "./punctuation-workspace-ui";
import { configureSourceView } from "./source-view-ui";
import { configureReadingType, onReadingTypeChange } from "./reading-type";
import { configureComparisonResize } from "./comparison-resize";
import { configureTermReview } from "./term-review-ui";
import { alignmentSettingsMarkup, changeAlignmentSetting } from "./alignment-settings-ui";
import { chatMessageMarkup, configureChatSurface, isChatSubmit } from "./chat-ui";
import { mountPopoverSelect } from "./popover-select";
import { thinkingMarkup, chatActivityMarkup } from "./thinking-ui";
import { createTranslationProgress, translationProgressState, translationRunLabel } from "./translation-progress-ui";
import { prepModelMarkup, changePrepModelSetting, prepAlignmentSummary, prepRequiredContent, isTechnicalPreparationItem } from "./translation-setup-ui";
import { t, ui, uiText } from "./i18n";
import { configureConcordance } from "./concordance-ui";
import { configureQuickTerm } from "./quick-term-ui";
import { USAGE_LABELS } from "./knowledge-model";
import { configureDictionary } from "./dictionary-ui";
import { configureReadingStudy } from "./reading-study-ui";
import { configureReviewExport } from "./review-export-ui";
import { configureTranslationChecks } from "./translation-checks-ui";
import { configureDocumentFind } from "./document-find-ui";
import type { CheckInput, TranslationCheck } from "./translation-checks";
import { editGroupedText, groupedTextSentences, matchUnchangedTextSentences, replaceTextSentence, textSentences, trimTextSentences, type TextSentence } from "@munhae/domain/text-sentences";
import { configureSentenceLinkUi } from "./sentence-link-ui";
import { termMarkup } from "./term-markup";
import { configureEditorAids, type TranslationDraft, type EditorRecovery } from "./editor-aids-ui";
import { findReviewPlace, type ReadingPosition } from "./editor-session";
import { configureReviewComments } from "./review-comments-ui";
import { textareaRange } from "./review-selection";
import { configureDocumentMaterials } from "./document-materials-ui";
import { createPunctuationProjection, projectSourceRange, type PunctuationProjection } from "./punctuation-projection";
import type {
  AgentProbe,
  AiRunView,
  AppConfig,
  ChatScopeKind,
  ContextPreview,
  DocumentListItem,
  EditorView,
  GlossaryEntryView,
  HomeView,
  KnowledgeView,
  PunctuationSuggestionView,
  StructureSpanInput,
  StructureSpanKind,
} from "../../shared/munhae-api";
import {
  $,
  $$,
  bindSidebar,
  defaultSidebarTree,
  esc,
  findDefaultDoc,
  go,
  ic,
  initShell,
  must,
  notify,
  nowHM,
  persistDoc,
  readPersistedDoc,
  renderSidebar,
  registerProjectRefresh,
  requireProject,
  setSelfTitle,
  projectLocationLabel,
  savedLocallyLabel,
  store,
  unwrap,
} from "./shared";
import {
  configureVersionHistoryUi,
  loadVersionHistory,
  openVersionDiff,
  renderVersionHistory,
} from "./version-history-ui";

const project = await requireProject();
if (!project) throw new Error("redirect");

type Layout = "source" | "parallel" | "full" | "reading";
type Workspace = "terms" | "source" | "punctuation" | "segmentation" | "translation";
type Block = {
  key: string;
  anchors: string[];
  relationKinds: string[];
  text: string;
  kind: string;
};

type TermInfo = { target: string; kind: string; status: GlossaryEntryView["usageStatus"]; note: string };

const api = initShell({
  page: "editor",
  extraEnabled: [
    "refpane",
    "ctxpane",
    "v-source",
    "v-parallel",
    "v-full",
    "struct",
    "keys",
    "merge",
    "split",
    "link",
    "diff",
    "confirm",
    "prepare",
    "run",
  ],
  selfTitle: ui`편집 — ${project.title}`,
  pageCmd,
  pageKeys,
  beforeNavigate: () => {
    if (!canLeaveEditor()) return false;
    clearUnsavedChanges();
    return true;
  },
  projectTransition: {
    before: () => canLeaveEditor(),
    committed: () => clearUnsavedChanges(),
  },
}).api;

configureVersionHistoryUi({ api, escape: esc, notify });

let docs: DocumentListItem[] = [];
let view: EditorView | null = null;
let punctuationProjection: PunctuationProjection | null = null;
let sourceCodepoints: string[] = [];
let parallelSource: "source" | "punctuation" = store.get("munhae.parallel-source") === "source" ? "source" : "punctuation";
let layout: Layout = "parallel";
let workspace: Workspace = "source";
let blocks: Block[] = [];
let dirty = false;
let translationSaving = false;
let workspaceSaving = false;
let workspaceSwitching = false;
const activeMutations = new Map<HTMLButtonElement, string>();
let editorLoadSerial = 0;
let editorEditSerial = 0;
let editorViewSerial = 0;
let translationDraftText = "";
let selectedSentenceId: string | null = null;
let sentenceDrafts: TextSentence[] = [];
let editingSentenceId: string | null = null;
/** Last saved text per group; group operations re-base only the groups they reshape. */
let savedGroupTexts = new Map<string, string>();
let bookEditCollapsed = store.get("munhae.book-edit.collapsed") === "1";
let groupStructureDirty = false;
/** The paragraph break chosen in the book view, named by the group after it. */
let selectedGapId: string | null = null;
let sentenceLinks: NonNullable<NonNullable<EditorView["translation"]>["textLayout"]>["links"] = [];
const pendingTranslationEdits = new Set<string>();
let blockOrderSaving = false;
let active: string | null = null;
let hot: string[] = [];
let sourceDirty = false;
let sourceEditingConfirmed = false;
let punctuationDirty = false;
let punctuationEditingConfirmed = false;
let structureDrafts: StructureSpanInput[] | undefined = [];
let terms: Record<string, TermInfo> = {};
let knowledge: KnowledgeView | null = null;
let splitIdx: number | null = null;
let linkIdx: number | null = null;
let cmIdx: number | null = null;
let prepPreview: ContextPreview | null = null;
let prepDocId: string | null = null;
let prepRevision: { baseVersionId: string; commentIds: string[] } | undefined;
let prepRequest = 0;
let prepPreviewPending = false;
let prepPreviewError: string | null = null;
const prepAuxMode = new Map<string, "auto" | "pin" | "exclude">();
const prepExpanded = new Set<string>();
let agentProbes: AgentProbe[] = [];
let appConfig: AppConfig | null = null;
let agentProbeLoading = false;
let agentProbeError: string | null = null;
let aiRun: AiRunView | null = null;
let aiStarting = false;
let prepProgressMode = false;
let prepSettingsSaveChain = Promise.resolve();
let prepSettingsSaveError: unknown = null;
let prepSettingsPending = 0;
let aiCanceling = false;
let aiActionError: { code: string; message: string } | null = null;
let aiPollTimer: number | null = null;
const handledAiTerminals = new Set<string>();
const finalizingAiTerminals = new Set<string>();
type AuxiliaryTaskKind = "chat" | "punctuation_suggest";
let auxiliaryRun: AiRunView | null = null;
let auxiliaryStarting: AuxiliaryTaskKind | null = null;
let auxiliaryCanceling = false;
let auxiliaryActionError: { kind: AuxiliaryTaskKind; code: string; message: string } | null = null;
let auxiliaryPollTimer: number | null = null;
let punctuationSuggestion: PunctuationSuggestionView | null = null;
let punctuationApplying = false;
let punctuationPreviewing = false;
let punctuationDraftBeforePreview: string | null = null;
let projectChat: EditorView["chat"] = [];
let chatLoadSerial = 0;
let pendingChatMessage: {
  documentNodeId: string;
  scopeKind: ChatScopeKind;
  text: string;
  createdAt: string;
  messageId: string | null;
} | null = null;
const handledAuxiliaryTerminals = new Set<string>();
const finalizingAuxiliaryTerminals = new Set<string>();
let activeReferenceId: string | null = null;
let referenceObjectUrl: string | null = null;
let loadedReferenceKey: string | null = null;
let referenceLoadSerial = 0;

const termReview = configureTermReview({ api, host: must("#termsWorkspace"), view: () => view,
  canStart: () => !sourceDirty && !punctuationDirty && !editorMutationBusy(),
  changed: () => { prepRevision = undefined; },
});

const reviewComments = configureReviewComments({
  api,
  openDictionary: context => dictionary.open(context),
  view: () => view?.translation?.textLayout ? { ...view, translation: { ...view.translation, textLayout: { ...view.translation.textLayout, sentences: sentenceDrafts, links: sentenceLinks } } } : view,
  hasUnsavedChanges: () => hasUnsavedChanges() || aiStarting || aiRun?.state === "running",
  hasUnsavedTextChanges: () => dirty || sourceDirty || punctuationDirty || translationSaving || workspaceSaving
    || aiStarting || aiRun?.state === "running" || auxiliaryStarting !== null || auxiliaryRun?.state === "running",
  canEditTranslation: (sentenceId) => editing() && !editorMutationBusy() && isSentenceEditing(sentenceId),
  escape: esc,
  notify,
  showComments: (next = "parallel") => {
    must<HTMLInputElement>("#alignmentReviewOnly").checked = false;
    must<HTMLInputElement>("#comparisonQuery").value = "";
    must<HTMLSelectElement>("#comparisonFilter").value = "all";
    setWorkspace("translation"); setView(next); setTab("comments");
  },
  retranslate: revision => { prepRevision = revision; openPreparationDialog(); },
  reuseComment: comment => documentMaterials.reuseComment(comment),
  changed: () => { renderComparisonState(); resizeSentenceEditors(); },
  compare: async () => {
    if (!view) return;
    await loadVersionHistory(view.document.id, "translation", "translation");
    openVersionDiff("translation", "translation", true);
  },
});

const documentMaterials = configureDocumentMaterials({
  api, documents: () => docs, view: () => view, escape: esc, notify,
  canChange: () => !aiStarting && aiRun?.state !== "running" && !auxiliaryStarting && auxiliaryRun?.state !== "running",
  openPreparation,
  openDocument: async id => { if (canLeaveEditor()) { clearUnsavedChanges(); await loadEditor(id); } },
  openMaterials: id => {
    if (!canLeaveEditor()) return;
    clearUnsavedChanges();
    location.href = `knowledge.html${id ? `?material=${encodeURIComponent(id)}` : ""}`;
  },
  changed: () => {
    prepRequest += 1;
    prepPreview = null;
    prepAuxMode.clear();
    if (must<HTMLDialogElement>("#dlgPrepare").open) void loadPreparation(true);
  },
});

const sentenceLinkUi = configureSentenceLinkUi({
  api, view: () => view, hasUnsavedChanges,
  apply: (data) => {
    applyView(data); must("#sbSaved").textContent = nowHM();
    queueMicrotask(() => { renderEditingLocks(); renderComparisonState(); renderSaveState(); });
  },
  escape: esc, notify,
});

const translationChecks = configureTranslationChecks({ snapshot: checkSnapshot, escape: esc, locate: locateCheck });
const documentFind = configureDocumentFind({ host: must("#translationWorkspace"), trigger: must("#btnDocumentFind"),
  source: () => view?.source.contentText ?? "", translation: () => view?.translation?.textLayout ? translationDraftText : joinBlocks(blocks),
  editable: () => !!view?.translation?.textLayout && editing() && !editorMutationBusy() && !reviewComments.isSelecting(),
  apply: applyFullTranslationText, locate: locateTextRange,
});
const concordance = configureConcordance({ api, escape: esc, notify, currentDocumentId: () => view?.document.id ?? null,
  openDocument: async (id, sentenceId, versionId) => {
    if (hasUnsavedChanges()) { notify(t("편집한 내용을 저장한 뒤 다른 용례 위치로 이동하세요."), t("내 번역 용례")); return; }
    if (view?.document.id !== id) await loadEditor(id);
    if (view?.document.id !== id) return;
    if (sentenceId && view.translation?.versionId === versionId) {
      document.querySelector<HTMLDialogElement>("#dlgConcordance")?.close();
      locateSentence(sentenceId);
    }
  },
});
const quickTerm = configureQuickTerm({ api, escape: esc, notify, getKnowledge: () => knowledge,
  onSaved: (entry) => {
    if (knowledge) knowledge.glossary.push(entry);
    const previous = terms[entry.sourceTerm];
    if (!previous || entry.usageStatus === "preferred") terms[entry.sourceTerm] = { target: entry.targetTerm, kind: entry.termKind, status: entry.usageStatus, note: entry.noteMd ?? "" };
    renderTerms(); renderSource();
  },
});
const dictionary = configureDictionary({ api, escape: esc, notify,
  register: (entry, citation) => quickTerm.open(entry.headword, { targetTerm: entry.reading ?? "", noteMd: citation }),
});
const readingStudy = configureReadingStudy({ api, host: must("#viewReading"), inspectorHost: must("#rp-reading"), openInspector: () => setTab("reading"), escape: esc, notify,
  canEdit: () => !!view && !sourceDirty && !punctuationDirty && !dirty && !translationSaving && !workspaceSaving && !workspaceSwitching && activeMutations.size === 0 && !sentenceLinkUi.isBusy(),
  changed: () => renderSaveState(),
  edited: () => { editorEditSerial += 1; },
});
const reviewExport = configureReviewExport({ api, currentDocumentId: () => view?.document.id ?? null, notify,
  beforeExport: () => {
    if (hasUnsavedChanges() || editorMutationBusy()) { notify(t("편집한 내용을 먼저 저장한 뒤 검토본을 출력하세요."), t("검토본 출력")); return false; }
    return true;
  },
});

function captureTranslation(): TranslationDraft {
  return structuredClone({ text: translationDraftText, sentences: sentenceDrafts, links: sentenceLinks, blocks, structureDirty: groupStructureDirty });
}
function editorPosition(): ReadingPosition {
  const sentence = sentenceDrafts.find(s => s.id === selectedSentenceId);
  return { workspace, layout, sentenceId: sentence?.id ?? null, quote: sentence?.text ?? "", from: sentence?.from ?? 0, translationVersion: view?.translation?.versionId ?? null, scrollTop: must(".pane-center .pane-scroll").scrollTop };
}
function restoreEditorPosition(position: ReadingPosition): void {
  const id = position.translationVersion === view?.translation?.versionId && sentenceDrafts.some(s => s.id === position.sentenceId)
    ? position.sentenceId : findReviewPlace({ sentenceId: position.sentenceId ?? "", from: position.from, quote: position.quote }, sentenceDrafts);
  selectedSentenceId = id;
  setWorkspace(position.workspace as Workspace); setView(position.layout as Layout);
  renderComparisonState(); renderBookGroups(); resizeSentenceEditors();
  must(".pane-center .pane-scroll").scrollTop = position.scrollTop;
}
function restoreTranslation(snapshot: TranslationDraft): void {
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
  const focusId = focused?.dataset.sentenceEdit, caret = focused?.selectionStart ?? 0;
  translationDraftText = snapshot.text; sentenceDrafts = snapshot.sentences; sentenceLinks = snapshot.links; blocks = snapshot.blocks;
  const saved = view?.translation;
  const groupKey = (sentences: TextSentence[], links: typeof sentenceLinks) => JSON.stringify(sentences.map(s => ({ text: s.text, spans: links.find(l => l.sentenceId === s.id)?.spans ?? [] })));
  groupStructureDirty = !!saved?.textLayout && groupKey(sentenceDrafts, sentenceLinks) !== groupKey(groupedTextSentences(saved.textContent, saved.textLayout.sentences, saved.textLayout.links), saved.textLayout.links);
  dirty = saved?.textLayout ? translationDraftText !== saved.textContent || groupStructureDirty : JSON.stringify(blocks) !== JSON.stringify(saved ? blocksFrom(saved) : []);
  if (!sentenceDrafts.some(s => s.id === editingSentenceId)) editingSentenceId = null;
  if (focusId && sentenceDrafts.some(s => s.id === focusId)) { selectedSentenceId = focusId; editingSentenceId = focusId; }
  must<HTMLTextAreaElement>("#fullTranslationInput").value = translationDraftText;
  must("#bookGroups").replaceChildren(); editorEditSerial++;
  reviewComments.cancelSelection(); renderRows(); renderFull(); renderStrip();
  if (focusId) {
    const field = Array.from(document.querySelectorAll<HTMLTextAreaElement>(".sentence-edit")).find(f => f.dataset.sentenceEdit === focusId && f.getClientRects().length);
    field?.focus({ preventScroll: true }); field?.setSelectionRange(caret, caret);
  }
}
const editorAids = configureEditorAids({
  root: must(".center-body"), escape: esc, notify,
  bookmarkRoot: must(".pane-center"),
  context: () => view ? {
    scope: JSON.stringify([project.packagePath, project.projectId, view.document.id]),
    base: JSON.stringify([view.source.versionId, view.source.lockVersion, view.punctuation?.versionId, view.punctuation?.lockVersion, view.translation?.versionId, view.translation?.lockVersion]),
    sourceVersion: view.source.versionId, translationVersion: view.translation?.versionId ?? null,
    editable: editing(), busy: editorMutationBusy(), dirty: sourceDirty || punctuationDirty || dirty, sentences: sentenceDrafts,
  } : null,
  capture: captureTranslation, restore: restoreTranslation,
  recovery: () => ({ translation: captureTranslation(), translationDirty: dirty,
    source: must<HTMLTextAreaElement>("#sourceDraftText").value, sourceDirty, sourceEditingConfirmed,
    punctuation: must<HTMLTextAreaElement>("#punctuationDraftText").value, punctuationDirty,
    punctuationMode: must<HTMLSelectElement>("#punctuationMode").value,
    structures: structureDrafts, position: editorPosition(),
  }),
  restoreRecovery: (draft: EditorRecovery) => {
    sourceDirty = draft.sourceDirty; sourceEditingConfirmed = draft.sourceEditingConfirmed;
    punctuationDirty = draft.punctuationDirty;
    punctuationEditingConfirmed = draft.punctuationDirty && view?.punctuation?.state === "confirmed";
    structureDrafts = draft.structures;
    must<HTMLTextAreaElement>("#sourceDraftText").value = draft.source;
    must<HTMLTextAreaElement>("#punctuationDraftText").value = draft.punctuation;
    must<HTMLSelectElement>("#punctuationMode").value = draft.punctuationMode;
    if (draft.translationDirty) restoreTranslation(draft.translation);
    renderDraftWorkspaces(); restoreEditorPosition(draft.position); editorEditSerial++;
  },
  position: editorPosition, restorePosition: restoreEditorPosition,
  changed: () => { renderRows(); const menu = must("#bookEditToolbar").querySelector<HTMLElement>(".book-group-menu"); if (menu) delete menu.dataset.sentence; renderBookGroups(); },
  locate: locateSentence,
});

function checkSnapshot(): CheckInput | null {
  if (!view) return null;
  return { identity: `${view.document.id}:${view.translation?.versionId ?? ""}`, source: view.source.contentText, translation: view.translation?.textLayout ? translationDraftText : joinBlocks(blocks),
    sentences: sentenceDrafts, links: sentenceLinks, glossary: knowledge?.glossary ?? [], comments: reviewComments.current(),
    currentDependencies: view.translation?.isCurrentDependencies ?? true, dirty, hasLayout: !!view.translation?.textLayout };
}
function selectedPhrase(): string {
  const selection = window.getSelection();
  if (selection?.anchorNode && !selection.isCollapsed && must("#translationWorkspace").contains(selection.anchorNode)) return Array.from(selection.toString()).slice(0, 200).join("");
  const focused = document.activeElement;
  if (focused instanceof HTMLTextAreaElement && focused.selectionStart !== focused.selectionEnd) return Array.from(focused.value.slice(focused.selectionStart, focused.selectionEnd)).slice(0, 200).join("");
  const field = lastSelectedTranslation;
  return field?.isConnected && field.getClientRects().length && field.selectionStart !== field.selectionEnd ? Array.from(field.value.slice(field.selectionStart, field.selectionEnd)).slice(0, 200).join("") : "";
}
let lastSelectedTranslation: HTMLTextAreaElement | null = null;
document.addEventListener("selectionchange", () => {
  const focused = document.activeElement;
  if (focused instanceof HTMLTextAreaElement && must("#translationWorkspace").contains(focused)) lastSelectedTranslation = focused;
});
function scrollToTextRect(rect: DOMRect, target: HTMLElement): void {
  const pane = target.closest<HTMLElement>(".folio-source, .folio-translation") ?? must(".pane-center .pane-scroll");
  const bounds = pane.getBoundingClientRect();
  pane.scrollTop += rect.top - bounds.top - bounds.height / 3;
}
function scrollTextareaSelection(field: HTMLTextAreaElement, at: number): void {
  const mirror = document.createElement("div");
  const style = getComputedStyle(field);
  mirror.style.cssText = "position:fixed;left:-10000px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;";
  for (const property of ["font", "line-height", "letter-spacing", "padding", "border", "box-sizing", "text-indent", "tab-size"]) mirror.style.setProperty(property, style.getPropertyValue(property));
  mirror.style.width = `${field.getBoundingClientRect().width}px`;
  mirror.textContent = field.value.slice(0, at);
  const marker = document.createElement("span"); marker.textContent = field.value.slice(at, at + 2) || " "; mirror.append(marker);
  document.body.append(mirror);
  const fieldRect = field.getBoundingClientRect();
  const top = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
  if (field.scrollHeight > field.clientHeight + 2) field.scrollTop = Math.max(0, top - field.clientHeight / 3);
  scrollToTextRect(new DOMRect(fieldRect.x, fieldRect.y + top - field.scrollTop, 1, 20), field);
  mirror.remove();
}
function locateSentence(id: string): void {
  must<HTMLInputElement>("#alignmentReviewOnly").checked = false;
  must<HTMLInputElement>("#comparisonQuery").value = "";
  must<HTMLSelectElement>("#comparisonFilter").value = "all";
  selectedSentenceId = id;
  setWorkspace("translation"); setView("parallel"); renderComparisonState(); resizeSentenceEditors();
  const row = $$("#rows [data-review-sentence]").find(item => item.dataset.reviewSentence === id);
  row?.scrollIntoView({ block: "center" });
  row?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
}
function locateTextRange(target: "source" | "translation", from: number, to: number): void {
  if (!view) return;
  reviewComments.cancelSelection(); setWorkspace("translation"); setView("full");
  if (target === "translation" && view.translation?.textLayout) {
    const pointFrom = Array.from(translationDraftText.slice(0, from)).length;
    const sentence = sentenceDrafts.find(sentence => sentence.to > pointFrom) ?? sentenceDrafts.at(-1);
    selectedGapId = null; editingSentenceId = null;
    if (sentence) selectedSentenceId = sentence.id;
    renderFull();
    const root = must("#bookGroups");
    const range = bookFlowRange(root, from, to);
    if (range) {
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      scrollToTextRect(range.getBoundingClientRect(), root);
    }
  } else if (target === "translation") {
    const root = must("#fullText");
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange(); let offset = 0; let started = false; let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (!started && from <= offset + length) { range.setStart(node, Math.max(0, from - offset)); started = true; }
      if (started && to <= offset + length) { range.setEnd(node, Math.max(0, to - offset)); break; }
      offset += length;
    }
    if (started) { const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range); scrollToTextRect(range.getBoundingClientRect(), root); }
  } else {
    const container = must("#folioSourceText");
    // Display exact source for offset navigation; normal view rendering restores punctuation.
    container.textContent = view.source.contentText;
    container.dataset.reviewSourceFrom = "0";
    container.dataset.reviewSourceTo = String(sourceCodepoints.length);
    container.dataset.reviewSourceQuote = view.source.contentText;
    delete container.dataset.reviewSourceMap;
    const node = container.firstChild;
    if (!node) return;
    const range = document.createRange(); range.setStart(node, Math.min(from, node.textContent?.length ?? 0)); range.setEnd(node, Math.min(to, node.textContent?.length ?? 0));
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    scrollToTextRect(range.getBoundingClientRect(), container); must("#folioSourceLabel").textContent = t("원문 · 선택 위치");
  }
}
function locateCheck(issue: TranslationCheck): void {
  if (issue.commentId) { must<HTMLInputElement>("#alignmentReviewOnly").checked = false; must<HTMLInputElement>("#comparisonQuery").value = ""; must<HTMLSelectElement>("#comparisonFilter").value = "all"; renderComparisonState(); reviewComments.locateById(issue.commentId); return; }
  if (issue.target && issue.from !== undefined && issue.to !== undefined) {
    const text = issue.target === "source" ? view?.source.contentText ?? "" : view?.translation?.textLayout ? translationDraftText : joinBlocks(blocks);
    locateTextRange(issue.target, Array.from(text).slice(0, issue.from).join("").length, Array.from(text).slice(0, issue.to).join("").length);
  } else if (issue.sentenceId) locateSentence(issue.sentenceId);
}
function comparisonSentences() {
  const only = must<HTMLInputElement>("#alignmentReviewOnly").checked;
  const query = must<HTMLInputElement>("#comparisonQuery").value.trim();
  let filter = must<HTMLSelectElement>("#comparisonFilter").value;
  if (dirty && filter === "comments") { filter = "all"; must<HTMLSelectElement>("#comparisonFilter").value = "all"; }
  const comments = reviewComments.current();
  return sentenceDrafts.filter(sentence => {
    if (dirty && sentence.id === selectedSentenceId) return true;
    const link = sentenceLinks.find(item => item.sentenceId === sentence.id);
    if (only && !sentenceNeedsReview(sentence.id)) return false;
    if (filter === "bookmarks" && !editorAids.isBookmarked(sentence.id)) return false;
    if (filter === "unlinked" && link?.spans.length) return false;
    if (filter === "comments" && (dirty || !comments.some(comment => comment.targetKind === "translation"
      ? comment.codepointFrom < sentence.to && comment.codepointTo > sentence.from
      : link?.spans.some(span => span.from < comment.codepointTo && span.to > comment.codepointFrom)))) return false;
    return !query || sentence.text.includes(query) || link?.spans.some(span => span.quote.includes(query) || displayedSource(span).text.includes(query));
  });
}

const VERSION_STATE_LABELS: Record<EditorView["source"]["state"], string> = {
  draft: t("작성 중"),
  confirmed: t("확정"),
  rejected: t("반려"),
  superseded: t("이전 버전"),
};

const STRUCTURE_KIND_LABELS: Record<StructureSpanKind, string> = {
  paragraph: t("문단"),
  sentence: t("문장"),
  verse_line: t("행"),
  couplet: t("대구"),
  stanza: t("연"),
};

function codepointLength(text: string): number {
  return Array.from(text).length;
}

function utf16CaretToCodepoint(text: string, caret: number): number {
  return Array.from(text.slice(0, caret)).length;
}

function translationLockVersion(): number | undefined {
  return view?.translation?.lockVersion;
}

function tree() {
  return defaultSidebarTree(docs);
}

window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  renderSidebar(tree(), { currentDocId: view?.document.id });
});

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

function prepReasonLabel(reason: string): string {
  if (reason === "current_document" || reason === "current_document_context") return t("현재 문서");
  if (reason.startsWith("ancestor_document_context:")) {
    return ui`상위 문서 · ${reason.split(":")[1]}단계`;
  }
  const labels: Record<string, string> = {
    exact_match: t("원문 일치"),
    related_uncertainty: t("현재 문서 앵커"),
    project_uncertainty: t("다른 문서의 불확실성"),
    project_glossary: t("공통 용어집"),
  };
  return labels[reason] ?? reason;
}

function selectedPrepAgent(): AgentProbe["agentId"] {
  return must<HTMLSelectElement>("#prepAgent").value as AgentProbe["agentId"];
}

function selectedChatAgent(): AgentProbe["agentId"] {
  return appConfig?.agentId ?? "claude";
}

function renderChatModelInfo(): void {
  const info = must("#chatModelInfo");
  if (!appConfig) {
    info.textContent = t("설정 확인 중…");
    return;
  }
  const prefs = appConfig.agentModels[selectedChatAgent()];
  const model = agentProbe(selectedChatAgent())?.models.find((item) => item.id === prefs.model);
  const modelLabel = !prefs.model || prefs.model === "default"
    ? t("CLI 기본값")
    : model?.label || prefs.model;
  info.textContent = `${modelLabel} · effort ${prefs.reasoning || t("CLI 기본값")}`;
}

function selectedChatScope(): ChatScopeKind {
  return must<HTMLSelectElement>("#chatScope").value === "project" ? "project" : "document_node";
}

function runChatScope(run: AiRunView): ChatScopeKind {
  return run.chatScopeKind === "project" ? "project" : "document_node";
}

function selectedPunctuationAgent(): AgentProbe["agentId"] {
  return must<HTMLSelectElement>("#punctuationAgent").value as AgentProbe["agentId"];
}

function agentLabel(agentId: AgentProbe["agentId"]): string {
  return agentId === "antigravity" ? "Antigravity CLI" : agentId === "codex" ? "Codex CLI" : "Claude CLI";
}

function selectedAgentProbe(): AgentProbe | undefined {
  const agentId = selectedPrepAgent();
  return agentProbes.find((probe) => probe.agentId === agentId);
}

function agentProbe(agentId: AgentProbe["agentId"]): AgentProbe | undefined {
  return agentProbes.find((probe) => probe.agentId === agentId);
}

function agentReady(agentId: AgentProbe["agentId"]): boolean {
  const probe = agentProbe(agentId);
  return !!probe?.installed && (probe.loggedIn === true || (probe.agentId === "antigravity" && probe.loggedIn === null));
}

function renderAgentOptions(): void {
  for (const select of [
    must<HTMLSelectElement>("#prepAgent"),
    must<HTMLSelectElement>("#punctuationAgent"),
  ]) {
    for (const option of [...select.options]) {
      const agentId = option.value as AgentProbe["agentId"];
      const probe = agentProbes.find((item) => item.agentId === agentId);
      const status = !probe
        ? t("상태 확인 전")
        : !probe.installed
          ? t("설치되지 않음")
          : probe.loggedIn === true
            ? t("연결됨")
            : probe.loggedIn === false
              ? t("로그인 필요")
              : t("로그인 상태 확인 불가");
      const version = probe?.version ? ` · ${probe.version}` : "";
      option.textContent = select.id === "prepAgent" && agentId === "antigravity" ? "Gemini · Antigravity" : agentLabel(agentId).replace(" CLI", "");
      option.title = `${agentLabel(agentId)}${version} · ${status}`;
    }
  }
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    queued: t("실행 대기"),
    starting: t("로컬 에이전트 시작"),
    preparing: t("요청 준비"),
    assembling: t("요청 조립"),
    spawning: t("로컬 에이전트 시작"),
    running: t("번역 생성"),
    streaming: t("번역 생성"),
    thinking: t("응답 구상"),
    parsing: t("응답 해석"),
    validating: t("응답 형식 확인"),
    validation_failed: t("응답 형식 확인 실패"),
    applying: t("번역안 저장"),
    translation_saved: t("문장을 연결하는 중"),
    aligning: t("문장을 연결하는 중"),
    stopping: t("실행 중지"),
    completed: t("번역 완료"),
    failed: t("실행 실패"),
    canceled: t("실행 취소"),
  };
  return labels[phase] ?? phase.replaceAll("_", " ");
}

function validationLabel(state: AiRunView["validationState"]): string | null {
  if (state === "valid") return t("형식·현재 분절 참조 확인 · 번역안 적용됨");
  if (state === "needs_review") return t("번역안 적용됨 · 재검토 필요");
  if (state === "invalid_unapplied") return t("형식 또는 현재 분절 참조 오류 · 번역안 미적용");
  return null;
}

function actionableAiError(runError: { code: string; message: string }): string {
  if (runError.code === "context_too_large") {
    return ui`${t(runError.message)} 문서를 장·절·편 단위로 나눈 뒤 다시 실행하세요.`;
  }
  if (runError.code === "auth_required" || runError.code === "auth_unknown") {
    return ui`${t(runError.message)} 설정에서 CLI 로그인 명령을 확인한 뒤 터미널에서 실행하세요.`;
  }
  return t(runError.message);
}

let punctuationProgressMode = false;
const punctuationProgress = createPunctuationProgress(must<HTMLDialogElement>("#dlgPunctuation"));
window.addEventListener("pagehide", event => { if (!event.persisted) punctuationProgress.dispose(); });
const punctuationActivityOverrides = new Map<string, boolean>();
let punctuationActivitySignature = "";
function renderPunctuationProgress(run: AiRunView | null, starting: boolean, running: boolean): void {
  if (running) punctuationProgressMode = true;
  const dialog = must<HTMLDialogElement>("#dlgPunctuation");
  dialog.dataset.mode = punctuationProgressMode ? "progress" : "setup";
  must("#punctuationRunPanel").hidden = !punctuationProgressMode;
  must("#punctuationPrepBack").hidden = !punctuationProgressMode || running;
  must("#punctuationPrepFootnote").className = punctuationProgressMode ? "prep-background-note" : "prep-setup-total";
  must("#punctuationPrepEyebrow").hidden = !punctuationProgressMode;
  must("#punctuationPrepHeading").textContent = punctuationProgressMode ? view?.document.originalTitle || view?.document.title || t("AI 표점 생성") : t("AI 표점 생성");
  must("#punctuationPrepProvider").textContent = agentLabel(run?.agentId ?? selectedPunctuationAgent()).replace(" CLI", "");
  const error = auxiliaryActionError?.kind === "punctuation_suggest" ? auxiliaryActionError : run?.error;
  punctuationProgress.update(run, starting, !!run && auxiliaryCanceling, error ? actionableAiError(error) : "");
  const container = must("#punctuationRunActivity");
  if (!container.dataset.bound) {
    container.dataset.bound = "true";
    container.addEventListener("click", event => {
      const details = (event.target as Element).closest("summary")?.parentElement as HTMLDetailsElement | null;
      if (details?.dataset.thinkingKey) punctuationActivityOverrides.set(details.dataset.thinkingKey, !details.open);
    });
  }
  const blocks = run?.activity?.filter(block => block.kind !== "text");
  const signature = JSON.stringify([run?.messageId, run?.state, blocks]);
  if (punctuationActivitySignature !== signature) {
    punctuationActivitySignature = signature;
    const top = container.scrollTop, pinned = container.scrollHeight - top - container.clientHeight < 48;
    container.innerHTML = run ? chatActivityMarkup(blocks, run.messageId, new Set(), undefined, {
      state: run.state, startedAt: run.startedAt, completedAt: run.completedAt, overrides: punctuationActivityOverrides, grouped: false,
    }) : "";
    container.hidden = !container.innerHTML;
    container.scrollTop = pinned ? container.scrollHeight : top;
  }
}
const prepActivityOverrides = new Map<string, boolean>();
const prepProgress = createTranslationProgress(must<HTMLDialogElement>("#dlgPrepare"));
window.addEventListener("pagehide", event => { if (!event.persisted) prepProgress.dispose(); });
let prepActivitySignature = "";
function renderPrepActivity(): void {
  const container = must<HTMLElement>("#prepRunActivity");
  if (!container.dataset.bound) {
    container.dataset.bound = "true";
    container.addEventListener("click", event => {
      const summary = (event.target as Element).closest("summary");
      const details = summary?.parentElement as HTMLDetailsElement | null;
      if (details?.dataset.thinkingKey) prepActivityOverrides.set(details.dataset.thinkingKey, !details.open);
    });
  }
  const blocks = aiRun?.activity?.filter(block => block.kind !== "text");
  const signature = JSON.stringify([aiRun?.messageId, aiRun?.state, blocks]);
  if (signature === prepActivitySignature) return;
  prepActivitySignature = signature;
  const top = container.scrollTop;
  const pinned = container.scrollHeight - top - container.clientHeight < 48;
  container.innerHTML = aiRun ? chatActivityMarkup(blocks, aiRun.messageId, new Set(), undefined, {
    state: aiRun.state, startedAt: aiRun.startedAt, completedAt: aiRun.completedAt, overrides: prepActivityOverrides, grouped: false,
  }) : "";
  container.hidden = !container.innerHTML;
  container.scrollTop = pinned ? container.scrollHeight : top;
}

function renderAiRunPanel(): void {
  const panel = must<HTMLElement>("#prepRunPanel");
  const stateTag = must("#prepRunState");
  const meter = must<HTMLElement>("#prepRunMeter");
  const partial = must<HTMLElement>("#prepRunPartial");
  const error = must<HTMLElement>("#prepRunError");
  const hasState = aiStarting || !!aiRun || !!aiActionError;
  panel.hidden = !hasState;
  renderPrepActivity();
  prepProgress.update(aiRun, aiStarting, aiCanceling);
  if (!hasState) return;

  const state: AiRunView["state"] = aiStarting ? "running" : (aiRun?.state ?? "failed");
  const labels: Record<AiRunView["state"], string> = {
    running: aiCanceling ? t("취소 요청 중") : ["translation_saved", "aligning"].includes(aiRun?.phase ?? "") ? t("문장을 연결하는 중") : t("실행 중"),
    completed: aiRun?.validationState === "invalid_unapplied"
      ? t("완료 · 미적용")
      : aiRun?.validationState === "needs_review"
        ? t("완료 · 재검토")
        : t("완료"),
    failed: t("실패"),
    canceled: t("취소됨"),
  };
  const classes: Record<AiRunView["state"], string> = {
    running: "tag tag-line",
    completed: "tag tag-ok",
    failed: "tag tag-danger",
    canceled: "tag tag-plain",
  };
  const stateClass = state === "completed" && aiRun?.validationState !== "valid"
    ? "tag tag-warn"
    : classes[state];
  stateTag.className = stateClass;
  stateTag.textContent = labels[state];
  meter.dataset.state = state;
  meter.dataset.validation = aiRun?.validationState ?? "";
  meter.setAttribute("aria-valuetext", labels[state]);
  meter.setAttribute("aria-busy", String(state === "running"));

  const validation = state === "running" ? null : validationLabel(aiRun?.validationState ?? null);
  const progress = translationProgressState(aiRun, aiStarting, aiCanceling);
  must("#prepRunPhase").textContent = t(progress.title);
  must("#prepRunDetail").textContent = t(progress.description);
  must("#prepLatestActivity").textContent = aiStarting ? t("요청 준비") : phaseLabel(aiRun?.phase ?? state);
  const differentDocument = !!aiRun && !!view && aiRun.documentNodeId !== view.document.id;
  must("#prepActivityDetail").textContent = [
    aiRun?.detail ? t(aiRun.detail) : null,
    validation,
    differentDocument ? t("다른 문서에서 시작한 실행입니다.") : null,
  ].filter(Boolean).join(" ") || t(progress.description);

  const partialText = aiRun?.partialText ?? "";
  partial.textContent = partialText.length > 12_000
    ? ui`…앞부분 생략…\n${partialText.slice(-12_000)}`
    : partialText;
  partial.hidden = !partial.textContent;
  partial.setAttribute("aria-label", t("현재까지 생성된 번역"));
  const runError = aiActionError ?? aiRun?.error;
  error.textContent = runError ? `${actionableAiError(runError)} (${runError.code})` : "";
  error.hidden = !runError;

}

function renderTranslationRunIndicator(): void {
  const currentDocument = !!view && (!aiRun || aiRun.documentNodeId === view.document.id);
  const label = currentDocument ? translationRunLabel(aiRun, aiStarting, aiCanceling) : null;
  const indicator = must<HTMLButtonElement>("#translationRunIndicator");
  indicator.hidden = !label;
  const text = label ? t(label) : "";
  const status = must("#translationRunLabel");
  if (status.textContent !== text) status.textContent = text;
  const accessibleLabel = label ? ui`${text} · 진행 화면 열기` : t("진행 화면 열기");
  if (indicator.getAttribute("aria-label") !== accessibleLabel) indicator.setAttribute("aria-label", accessibleLabel);
  const buttonLabel = must("#prepareButtonLabel");
  const action = label ? t("진행 보기") : view?.translation?.isCurrentDependencies ? t("새 AI 번역… ") : t("AI 번역… ");
  if (buttonLabel.textContent !== action) buttonLabel.textContent = action;
}

function renderPreparationControls(): void {
  renderTranslationRunIndicator();
  const selectedId = selectedPrepAgent();
  const probe = selectedAgentProbe();
  const running = aiRun?.state === "running";
  const runButton = must<HTMLButtonElement>("#prepRun");
  const cancelButton = must<HTMLButtonElement>("#prepCancel");
  const controlsLocked = aiStarting || running || activeAuxiliaryKind() !== null;
  const available = !!probe?.installed && (probe.loggedIn === true || (probe.agentId === "antigravity" && probe.loggedIn === null));

  must<HTMLSelectElement>("#prepAgent").disabled = controlsLocked;
  $$("#prepModelSettings select").forEach(element => {
    const select = element as HTMLSelectElement;
    select.disabled = controlsLocked || agentProbeLoading || select.dataset.capabilityDisabled === "true";
  });
  $$("#prepAlignmentSettings select").forEach(element => {
    const select = element as HTMLSelectElement;
    select.disabled = controlsLocked || agentProbeLoading || select.dataset.capabilityDisabled === "true";
  });
  $$("#prepAux button[data-prep-mode]").forEach((button) => {
    (button as HTMLButtonElement).disabled = controlsLocked;
  });
  if (aiStarting || running) prepProgressMode = true;
  const dialog = must("#dlgPrepare");
  const mode = prepProgressMode ? "progress" : "setup";
  if (dialog.dataset.mode !== mode) dialog.dataset.mode = mode;
  must<HTMLButtonElement>("#prepBack").hidden = !prepProgressMode || aiStarting || running;
  if (prepProgressMode) {
    must("#prepHeading").textContent = view?.document.originalTitle || view?.document.title || t("AI 번역 진행");
  }
  must("#prepEyebrow").textContent = t(prepProgressMode ? "AI 번역" : "현재 문서에서 실행");
  must("#prepProvider").textContent = agentLabel(aiRun?.agentId ?? selectedId).replace(" CLI", "");
  must("#prepBackgroundNote").hidden = !prepProgressMode || !(aiStarting || running);
  must<HTMLButtonElement>("#prepClose").classList.toggle("btn-primary", prepProgressMode);
  runButton.hidden = prepProgressMode;
  runButton.disabled = !prepPreview || prepPreviewPending || !!prepPreviewError || agentProbeLoading || !available || controlsLocked || hasUnsavedChanges() || prepSettingsPending > 0 || !!prepSettingsSaveError;
  runButton.textContent = aiStarting
    ? t("실행 시작 중…")
    : prepRevision ? t("재번역 시작") : t("번역 시작");
  cancelButton.hidden = !running;
  cancelButton.disabled = aiCanceling;
  cancelButton.textContent = aiCanceling ? t("취소 요청 중…") : t("실행 중지");
  must<HTMLButtonElement>("#prepRetrySettings").hidden = !prepSettingsSaveError || prepSettingsPending > 0;

  if (prepPreview && !running && !aiStarting) {
    const status = must("#prepStatus");
    const note = must("#prepNote");
    note.hidden = false;
    if (prepPreviewError) {
      status.className = "tag tag-warn";
      status.textContent = t("확인 필요");
      note.textContent = prepPreviewError;
    } else if (prepPreviewPending) {
      status.className = "tag tag-line";
      status.textContent = t("자료 확인 중");
      note.hidden = true;
    } else if (prepSettingsSaveError) {
      status.className = "tag tag-warn";
      status.textContent = t("저장 실패");
      note.textContent = t("AI 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
    } else if (prepSettingsPending > 0) {
      status.className = "tag tag-line";
      status.textContent = t("설정 저장 중");
      note.hidden = true;
    } else if (hasUnsavedChanges()) {
      status.className = "tag tag-warn";
      status.textContent = t("저장 필요");
      note.textContent = t("편집 중인 변경을 먼저 저장한 뒤 AI 번역을 실행하세요.");
    } else if (agentProbeLoading) {
      status.className = "tag tag-plain";
      status.textContent = t("연결 확인 중");
      note.hidden = true;
    } else if (!available) {
      status.className = "tag tag-warn";
      status.textContent = t("연결 필요");
      note.textContent = agentProbeError
        ?? probe?.detail
        ?? (!probe?.installed
          ? ui`${agentLabel(selectedId)}를 설치한 뒤 다시 확인하세요.`
          : ui`${agentLabel(selectedId)}에 로그인한 뒤 다시 확인하세요.`);
    } else {
      status.className = "tag tag-ok";
      status.textContent = t("연결됨");
      note.textContent = "";
      note.hidden = true;
    }
  }
  renderAiRunPanel();
  reviewComments.refreshAvailability();
}

function createPreparationContent(content: string, key: string, label: string, metadata?: string): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "prep-content";
  details.open = prepExpanded.has(key);

  const summary = document.createElement("summary");
  summary.textContent = t("내용 펼쳐 보기");
  summary.setAttribute("aria-label", ui`${label} 내용 펼쳐 보기`);

  const body = document.createElement("pre");
  body.className = "prep-content-body";
  body.textContent = content;

  details.append(summary, body);
  if (metadata) {
    const info = document.createElement("p");
    info.className = "prep-content-meta";
    info.textContent = metadata;
    details.append(info);
  }
  details.addEventListener("toggle", () => {
    if (details.open) prepExpanded.add(key);
    else prepExpanded.delete(key);
  });
  return details;
}

function appendRequiredPreparationItem(
  container: HTMLElement,
  item: ContextPreview["required"][number],
): void {
  const technical = isTechnicalPreparationItem(item);
  const card = document.createElement("div");
  card.className = "prep-item";
  card.dataset.prepKind = item.kind;

  const row = document.createElement("div");
  row.className = "prep-item-row";

  const main = document.createElement("div");
  main.className = "prep-item-main";
  const title = document.createElement("b");
  title.textContent = t(item.label);
  main.append(title);

  row.append(main);
  if (technical || item.kind === "source" || item.kind === "base_translation") {
    const count = document.createElement("div");
    count.className = "prep-item-count";
    count.textContent = ui`${fmt(item.chars)}자`;
    row.append(count);
  }
  card.append(row);
  if (technical) {
    card.append(createPreparationContent(item.content, `required:${item.kind}`, item.label, [item.kind, item.version, item.hash].filter(Boolean).join(" · ")));
  } else {
    const content = prepRequiredContent(item);
    if (content.text) {
      if (item.kind === "target_language" || content.fields) {
        const text = document.createElement("p");
        text.className = "prep-readable-note";
        text.textContent = content.text;
        card.append(text);
      } else {
        card.append(createPreparationContent(content.text, `required:${item.kind}`, item.label));
      }
    }
    if (content.fields) {
      const fields = document.createElement("dl");
      fields.className = "prep-readable-fields";
      for (const field of content.fields) {
        const label = document.createElement("dt");
        label.textContent = field.label;
        const value = document.createElement("dd");
        value.textContent = field.value;
        fields.append(label, value);
      }
      card.append(fields);
    }
  }
  container.append(card);
}

function appendAuxiliaryPreparationItem(
  container: HTMLElement,
  item: ContextPreview["auxiliary"][number],
): HTMLElement {
  const mode = prepAuxMode.get(item.id) ?? item.selection;
  const card = document.createElement("div");
  card.className = `prep-item${item.included ? "" : " is-off"}`;
  card.dataset.prepItemId = item.id;

  const row = document.createElement("div");
  row.className = "prep-item-row";

  const main = document.createElement("div");
  main.className = "prep-item-main";
  const title = document.createElement("b");
  title.textContent = item.label;
  const metadata = document.createElement("div");
  metadata.className = "prep-item-sub";
  metadata.textContent = `${prepReasonLabel(item.reason)} · ${item.included ? t("포함") : t("제외됨")}`;
  main.append(title, metadata);

  const count = document.createElement("div");
  count.className = "prep-item-count";
  count.textContent = item.chars ? ui`${fmt(item.chars)}자` : "—";

  row.append(main, count);
  if (item.chars) {
    const choice = document.createElement("div");
    choice.className = "seg prep-choice";
    choice.setAttribute("role", "group");
    choice.setAttribute("aria-label", ui`${item.label} 전송 방식`);
    choice.dataset.prepId = item.id;
    for (const [modeId, modeLabel] of [
      ["auto", t("자동")],
      ["pin", t("고정")],
      ["exclude", t("제외")],
    ] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.prepMode = modeId;
      button.setAttribute("aria-pressed", String(mode === modeId));
      button.textContent = modeLabel;
      choice.append(button);
    }
    row.append(choice);
  } else {
    const lock = document.createElement("span");
    lock.className = "prep-lock";
    lock.textContent = t("해당 없음");
    row.append(lock);
  }

  card.append(row, createPreparationContent(item.content, `auxiliary:${item.id}`, item.label, `${item.kind} · ${item.hash}`));
  container.append(card);
  return card;
}

/** Keep the active button and open content panels mounted when inclusion changes. */
function updatePreparationMaterials(): void {
  if (!prepPreview) return;
  const required = must("#prepRequired");
  const signature = JSON.stringify(prepPreview.required.map(item => [item.kind, item.hash, item.version, item.label, item.chars]));
  if (required.dataset.signature !== signature) {
    required.replaceChildren();
    const technical = must("#prepTechnicalInputs");
    technical.replaceChildren();
    for (const item of prepPreview.required) appendRequiredPreparationItem(isTechnicalPreparationItem(item) ? technical : required, item);
    required.dataset.signature = signature;
  }
  const auxiliary = must("#prepAux");
  const existing = new Map([...auxiliary.querySelectorAll<HTMLElement>(":scope > [data-prep-item-id]")].map(card => [card.dataset.prepItemId!, card]));
  const ids = new Set(prepPreview.auxiliary.map(item => item.id));
  for (const child of [...auxiliary.children]) {
    if (!(child instanceof HTMLElement) || !ids.has(child.dataset.prepItemId ?? "")) child.remove();
  }
  prepPreview.auxiliary.forEach((item, index) => {
    let card = existing.get(item.id);
    if (card && !!item.chars !== !!card.querySelector("[data-prep-id]")) { card.remove(); card = undefined; }
    if (!card) card = appendAuxiliaryPreparationItem(auxiliary, item);
    card.classList.toggle("is-off", !item.included);
    const setText = (selector: string, text: string) => {
      const element = card!.querySelector<HTMLElement>(selector);
      if (element && element.textContent !== text) element.textContent = text;
    };
    setText(".prep-item-main b", item.label);
    setText(".prep-item-sub", `${prepReasonLabel(item.reason)} · ${item.included ? t("포함") : t("제외됨")}`);
    setText(".prep-item-count", item.chars ? ui`${fmt(item.chars)}자` : "—");
    setText(".prep-content-body", item.content);
    setText(".prep-content-meta", `${item.kind} · ${item.hash}`);
    card.querySelector(".prep-content > summary")?.setAttribute("aria-label", ui`${item.label} 내용 펼쳐 보기`);
    card.querySelectorAll<HTMLElement>("[data-prep-mode]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.prepMode === (prepAuxMode.get(item.id) ?? item.selection)));
    });
    if (auxiliary.children[index] !== card) auxiliary.insertBefore(card, auxiliary.children[index] ?? null);
  });
  if (!prepPreview.auxiliary.length) {
    const empty = document.createElement("p");
    empty.className = "prep-empty";
    empty.textContent = t("현재 문서에 연결된 참고 자료가 없습니다.");
    auxiliary.append(empty);
  }
}

function renderPreparationBudget(entries: Array<{
  label: string;
  value: string | [string, string];
  className?: string;
}>): void {
  const budget = must("#prepBudget");
  budget.replaceChildren();
  for (const entry of entries) {
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    term.textContent = entry.label;
    if (entry.className) {
      definition.className = entry.className;
      if (entry.className === "prep-total") term.className = entry.className;
    }
    if (Array.isArray(entry.value)) {
      definition.append(document.createTextNode(entry.value[0]), document.createElement("br"), entry.value[1]);
    } else {
      definition.textContent = entry.value;
    }
    budget.append(term, definition);
  }
}

async function refreshAgentProbes(): Promise<void> {
  agentProbeLoading = true;
  agentProbeError = null;
  renderPreparationControls();
  try {
    agentProbes = await api.app.probeAgents();
  } catch (error) {
    agentProbeError = error instanceof Error ? error.message : t("에이전트 연결 상태를 확인하지 못했습니다.");
  } finally {
    agentProbeLoading = false;
    renderAgentOptions();
    renderPunctuationPreparationSettings();
    renderPreparationSettings();
    renderPreparationControls();
    renderAuxiliaryRunControls();
  }
}

function renderPreparationSettings(): void {
  if (!appConfig) return;
  const selected = selectedPrepAgent();
  must("#prepModelSettings").innerHTML = prepModelMarkup(appConfig, agentProbe(selected), selected);
  const preferences = appConfig.agentModels[selected];
  const model = agentProbe(selected)?.models.find(item => item.id === preferences.model)?.label;
  const summary = [agentLabel(selected).replace(" CLI", ""), preferences.model === "default" ? t("CLI 기본값") : model ?? preferences.model, preferences.reasoning].filter(Boolean).join(" · ");
  must("#prepAiSummary").textContent = summary;
  must("#prepAiSummary").title = summary;
  const alignment = must("#prepAlignmentSettings");
  alignment.innerHTML = alignmentSettingsMarkup(appConfig, agentProbes, "prep-alignment");
  alignment.querySelectorAll<HTMLSelectElement>("select").forEach(select => {
    select.dataset.capabilityDisabled = String(select.disabled);
  });
  must("#prepAlignmentSummary").textContent = prepAlignmentSummary(appConfig, agentProbes);
}

function renderPreparation(keepSettings = false): void {
  if (!view || !prepPreview) return;
  const scroller = must("#dlgPrepare .ai-run-body");
  const scrollTop = scroller.scrollTop;
  const title = view.document.originalTitle || view.document.title;
  const reqChars = prepPreview.required.reduce((sum, item) => sum + item.chars, 0);
  const auxChars = prepPreview.auxiliary
    .filter((item) => item.included)
    .reduce((sum, item) => sum + item.chars, 0);

  must("#prepHeading").textContent = prepRevision ? t("코멘트를 반영한 재번역") : t("AI 번역");
  must("#prepTitle").textContent = prepRevision
    ? ui`${title}의 원문·현재 번역·선택한 코멘트 ${prepRevision.commentIds.length}개를 함께 보냅니다. 이전 번역은 보존됩니다.`
    : title;
  must("#prepTotal").textContent = ui`전송 분량 ${fmt(prepPreview.characterCount)}자`;
  const sourceChars = prepPreview.required.find(item => item.kind === "source")?.chars ?? 0;
  const included = prepPreview.auxiliary.filter(item => item.included).length;
  must("#prepMaterialsSummary").textContent = ui`원문 ${fmt(sourceChars)}자 · 참고 자료 ${included}개`;
  updatePreparationMaterials();
  const selectedAgent = selectedPrepAgent();
  if (!keepSettings) renderPreparationSettings();
  const preferences = appConfig?.agentModels[selectedAgent];
  const serviceTier = selectedAgent !== "codex"
    ? ui`N/A · ${agentLabel(selectedAgent)} 미지원`
    : (preferences?.serviceTier ?? t("CLI 기본값"));
  renderPreparationBudget([
    { label: t("문서"), value: title, className: "hanmun" },
    { label: t("에이전트"), value: agentLabel(selectedAgent) },
    { label: t("모델"), value: preferences?.model ?? "default", className: "mono" },
    { label: "Reasoning", value: preferences?.reasoning ?? t("CLI 기본값"), className: "mono" },
    { label: "Service tier", value: serviceTier, className: "mono" },
    { label: t("필수 입력"), value: ui`${fmt(reqChars)}자` },
    { label: t("보조 자료"), value: ui`${fmt(auxChars)}자` },
    {
      label: t("실제 요청"),
      value: [ui`${fmt(prepPreview.characterCount)}자`, `${fmt(prepPreview.utf8ByteCount)} B`],
      className: "prep-total",
    },
  ]);
  try {
    must("#prepManifest").textContent = JSON.stringify(JSON.parse(prepPreview.manifestJson) as unknown, null, 2);
  } catch {
    must("#prepManifest").textContent = prepPreview.manifestJson;
  }
  must("#prepManifestHash").textContent = `sha256 ${prepPreview.manifestHash.slice(0, 12)}…`;
  must("#prepRequestText").textContent = prepPreview.requestText;
  must("#prepRequestHash").textContent = `sha256 ${prepPreview.requestHash.slice(0, 12)}…`;
  renderPreparationControls();
  scroller.scrollTop = scrollTop;
}

function showPreparationLoading(): void {
  prepPreview = null;
  const requiredLoading = document.createElement("p");
  requiredLoading.className = "muted";
  requiredLoading.textContent = t("필수 입력을 불러오는 중입니다.");
  must("#prepRequired").replaceChildren(requiredLoading);
  must("#prepTechnicalInputs").replaceChildren();
  delete must("#prepRequired").dataset.signature;
  const auxiliaryLoading = document.createElement("p");
  auxiliaryLoading.className = "muted";
  auxiliaryLoading.textContent = t("보조 자료를 불러오는 중입니다.");
  must("#prepAux").replaceChildren(auxiliaryLoading);
  must("#prepTotal").textContent = t("전송 자료 계산 중");
  must("#prepStatus").className = "tag tag-plain";
  must("#prepStatus").textContent = t("계산 중");
  must("#prepBudget").replaceChildren();
  must("#prepNote").textContent = "";
  must("#prepNote").hidden = true;
  must("#prepMaterialsSummary").textContent = t("자료 확인 중");
  must("#prepManifest").textContent = "";
  must("#prepManifestHash").textContent = "";
  must("#prepRequestText").textContent = "";
  must("#prepRequestHash").textContent = "";
  renderPreparationControls();
}

async function loadPreparation(preserveSelections = false): Promise<void> {
  if (!view) return;
  const documentNodeId = view.document.id;
  const request = ++prepRequest;
  const refreshing = preserveSelections && prepDocId === documentNodeId && !!prepPreview;
  if (!preserveSelections || prepDocId !== documentNodeId) prepAuxMode.clear();
  prepDocId = documentNodeId;
  prepPreviewPending = true;
  prepPreviewError = null;
  if (refreshing) renderPreparationControls();
  else showPreparationLoading();
  let result: Awaited<ReturnType<typeof api.context.preview>>;
  try {
    result = await api.context.preview({
      documentNodeId,
      revision: prepRevision,
      referenceCommentIds: documentMaterials.referenceCommentIds(),
      selections: [...prepAuxMode].map(([id, mode]) => ({ id, mode })),
    });
  } catch (error) {
    if (request !== prepRequest || view?.document.id !== documentNodeId) return;
    const message = error instanceof Error ? error.message : t("전송 자료를 만들지 못했습니다.");
    prepPreviewPending = false;
    prepPreviewError = message;
    renderPreparationControls();
    must("#prepStatus").className = "tag tag-danger";
    must("#prepStatus").textContent = t("연결 오류");
    must("#prepNote").textContent = message;
    must("#prepNote").hidden = false;
    must("#prepTotal").textContent = t("전송 자료를 만들 수 없음");
    notify(message, t("AI 번역"));
    return;
  }
  if (request !== prepRequest || view?.document.id !== documentNodeId) return;
  prepPreviewPending = false;
  if (!result.ok) {
    const message = actionableAiError(result.error);
    prepPreviewError = message;
    renderPreparationControls();
    must("#prepStatus").className = "tag tag-warn";
    must("#prepStatus").textContent = t("확인 필요");
    must("#prepNote").textContent = message;
    must("#prepNote").hidden = false;
    must("#prepTotal").textContent = t("전송 자료를 만들 수 없음");
    notify(message, t("AI 번역"));
    return;
  }
  prepPreview = result.data;
  prepAuxMode.clear();
  for (const item of result.data.auxiliary) prepAuxMode.set(item.id, item.selection);
  renderPreparation(refreshing);
}

function openPreparation(): void {
  prepRevision = undefined;
  openPreparationDialog();
}

function openPreparationDialog(): void {
  if (!view || !translationReady()) {
    notify(t("원문을 먼저 저장하세요"), t("AI 번역"));
    setWorkspace("source");
    return;
  }
  const dialog = must("#dlgPrepare") as HTMLDialogElement;
  prepProgressMode = aiStarting || aiRun?.state === "running";
  if (!dialog.open) dialog.showModal();
  renderPreparationSettings();
  renderPreparationControls();
  void refreshAgentProbes();
  void loadPreparation(prepDocId === view.document.id);
}

function clearAiPoll(): void {
  if (aiPollTimer === null) return;
  window.clearTimeout(aiPollTimer);
  aiPollTimer = null;
}

function scheduleAiPoll(messageId: string): void {
  clearAiPoll();
  if (aiRun?.messageId !== messageId || aiRun.state !== "running") return;
  aiPollTimer = window.setTimeout(() => {
    aiPollTimer = null;
    void pollAiRun(messageId);
  }, 900);
}

async function pollAiRun(messageId: string): Promise<void> {
  if (aiRun?.messageId !== messageId || aiRun.state !== "running") return;
  try {
    const result = await api.ai.get(messageId);
    if (!result.ok) {
      aiActionError = result.error;
      renderPreparationControls();
      scheduleAiPoll(messageId);
      return;
    }
    receiveAiRun(result.data);
  } catch (error) {
    aiActionError = {
      code: "run_status_unavailable",
      message: error instanceof Error ? error.message : t("실행 상태를 확인하지 못했습니다."),
    };
    renderPreparationControls();
    scheduleAiPoll(messageId);
  }
}

function receiveAiRun(next: AiRunView): void {
  if (next.documentNodeId !== view?.document.id) return;
  if (aiRun && aiRun.messageId !== next.messageId) {
    if (aiRun.state === "running" || next.startedAt < aiRun.startedAt) return;
    aiRun = null;
  }
  if (aiRun && aiRun.state !== "running" && next.state === "running") return;

  aiRun = next;
  aiStarting = false;
  aiCanceling = next.state === "running" && next.phase === "stopping";
  aiActionError = null;
  renderPreparationControls();
  if (next.state === "running") {
    scheduleAiPoll(next.messageId);
    return;
  }
  clearAiPoll();
  if (!handledAiTerminals.has(next.messageId) && !finalizingAiTerminals.has(next.messageId)) {
    finalizingAiTerminals.add(next.messageId);
    window.setTimeout(() => void finalizeAiRun(next.messageId), 120);
  }
}

async function finalizeAiRun(messageId: string): Promise<void> {
  try {
    const result = await api.ai.get(messageId);
    if (result.ok && result.data.messageId === messageId && result.data.state !== "running") {
      aiRun = result.data;
      aiActionError = null;
      renderPreparationControls();
    }
  } catch {
    // The terminal push/poll result remains usable if this authoritative refresh fails.
  }
  finalizingAiTerminals.delete(messageId);
  const terminal = aiRun;
  if (!terminal || terminal.messageId !== messageId || terminal.state === "running") {
    if (terminal?.messageId === messageId) scheduleAiPoll(messageId);
    return;
  }
  if (handledAiTerminals.has(messageId)) return;
  handledAiTerminals.add(messageId);

  if (terminal.state === "canceled") {
    notify(t("AI 번역 실행을 취소했습니다."), t("AI 번역"));
    return;
  }
  if (terminal.state === "failed") {
    const runError = terminal.error ?? { code: "ai_run_failed", message: terminal.detail ?? t("AI 번역을 완료하지 못했습니다.") };
    notify(actionableAiError(runError), t("AI 번역 실패"));
    return;
  }

  const invalid = terminal.validationState === "invalid_unapplied";
  if (view?.document.id === terminal.documentNodeId) {
    if (hasUnsavedChanges()) {
      aiActionError = {
        code: "unsaved_changes",
        message: t("실행은 완료됐지만 미저장 편집을 보호하기 위해 결과 새로고침을 보류했습니다. 변경을 저장한 뒤 문서를 다시 여세요."),
      };
      renderPreparationControls();
      notify(aiActionError.message, t("AI 번역 완료"));
      return;
    }
    await loadEditor(terminal.documentNodeId);
    if (translationReady() && view?.translation?.isCurrentDependencies) setWorkspace("translation");
  }

  if (invalid) {
    notify(t("AI 응답은 기록에 보존됐지만 형식 또는 현재 분절 참조가 맞지 않아 번역안에는 적용되지 않았습니다."), t("AI 번역"));
    return;
  }
  const dialog = must<HTMLDialogElement>("#dlgPrepare");
  if (dialog.open) dialog.close();
  notify(
    terminal.validationState === "needs_review"
      ? t("완성 번역을 가져왔지만 구조 검증 항목이 있어 재검토가 필요합니다.")
      : t("AI가 완성본으로 제출한 단일 번역을 번역 작업안으로 가져왔습니다."),
    t("AI 번역 완료"),
  );
}

async function startAiTranslation(): Promise<void> {
  if (
    !view
    || !prepPreview
    || prepPreviewPending
    || !!prepPreviewError
    || aiStarting
    || aiRun?.state === "running"
    || auxiliaryStarting
    || auxiliaryRun?.state === "running"
  ) return;
  if (hasUnsavedChanges()) {
    notify(t("편집 중인 변경을 먼저 저장한 뒤 AI 번역을 실행하세요."), t("AI 번역"));
    renderPreparationControls();
    return;
  }
  const probe = selectedAgentProbe();
  if (!probe?.installed || (probe.loggedIn !== true && !(probe.agentId === "antigravity" && probe.loggedIn === null))) {
    notify(ui`${agentLabel(selectedPrepAgent())}의 설치와 로그인을 확인하세요.`, t("AI 번역"));
    renderPreparationControls();
    return;
  }

  aiRun = null;
  prepActivityOverrides.clear();
  must<HTMLDetailsElement>("#prepActivityDisclosure").open = false;
  aiActionError = null;
  aiStarting = true;
  renderPreparationControls();
  const launchDocumentId = view.document.id;
  const referenceCommentIds = documentMaterials.referenceCommentIds();
  try {
    await prepSettingsSaveChain;
    if (prepSettingsSaveError) throw prepSettingsSaveError;
    const result = await api.ai.startTranslation({
      documentNodeId: launchDocumentId,
      revision: prepRevision,
      referenceCommentIds,
      selections: [...prepAuxMode].map(([id, mode]) => ({ id, mode })),
      agentId: selectedPrepAgent(),
    });
    if (!result.ok) {
      aiStarting = false;
      aiActionError = result.error;
      renderPreparationControls();
      notify(actionableAiError(result.error), t("AI 번역을 시작하지 못했습니다"));
      return;
    }
    documentMaterials.clearLaunchedComments(launchDocumentId, referenceCommentIds);
    receiveAiRun(result.data);
  } catch (error) {
    aiStarting = false;
    aiActionError = {
      code: "ai_start_unavailable",
      message: error instanceof Error ? error.message : t("AI 번역 실행을 시작하지 못했습니다."),
    };
    renderPreparationControls();
    notify(aiActionError.message, t("AI 번역을 시작하지 못했습니다"));
  }
}

async function cancelAiTranslation(): Promise<void> {
  if (!aiRun || aiRun.state !== "running" || aiCanceling) return;
  const messageId = aiRun.messageId;
  aiCanceling = true;
  aiActionError = null;
  renderPreparationControls();
  try {
    const result = await api.ai.cancel(messageId);
    if (!result.ok) {
      aiCanceling = false;
      aiActionError = result.error;
      renderPreparationControls();
      notify(result.error.message, t("실행을 취소하지 못했습니다"));
      scheduleAiPoll(messageId);
      return;
    }
    receiveAiRun(result.data);
  } catch (error) {
    aiCanceling = false;
    aiActionError = {
      code: "ai_cancel_unavailable",
      message: error instanceof Error ? error.message : t("취소 요청을 전달하지 못했습니다."),
    };
    renderPreparationControls();
    notify(aiActionError.message, t("실행을 취소하지 못했습니다"));
    scheduleAiPoll(messageId);
  }
}

function activeAuxiliaryKind(): AuxiliaryTaskKind | null {
  if (auxiliaryStarting) return auxiliaryStarting;
  if (auxiliaryRun?.state === "running" && auxiliaryRun.taskKind !== "translation") return auxiliaryRun.taskKind;
  return null;
}

function auxiliaryStatus(kind: AuxiliaryTaskKind, agentId: AgentProbe["agentId"]): string {
  if (auxiliaryStarting === kind) return ui`${agentLabel(agentId)}에 실행을 요청하는 중입니다.`;
  if (auxiliaryActionError?.kind === kind) {
    return `${actionableAiError(auxiliaryActionError)} (${auxiliaryActionError.code})`;
  }
  if (
    auxiliaryRun?.taskKind === kind
    && auxiliaryRun.documentNodeId === view?.document.id
    && (kind !== "chat" || runChatScope(auxiliaryRun) === selectedChatScope())
  ) {
    if (auxiliaryRun.state === "running") {
      if (kind === "chat") return "";
      return [phaseLabel(auxiliaryRun.phase), auxiliaryRun.detail ? t(auxiliaryRun.detail) : null].filter(Boolean).join(" · ");
    }
    if (auxiliaryRun.state === "failed") {
      return actionableAiError(auxiliaryRun.error ?? {
        code: "ai_run_failed",
        message: auxiliaryRun.detail ?? t("AI 실행을 완료하지 못했습니다."),
      });
    }
    if (auxiliaryRun.state === "canceled") return t("실행을 취소했습니다.");
    return auxiliaryRun.detail ? t(auxiliaryRun.detail) : t("실행을 완료했습니다.");
  }
  const probe = agentProbe(agentId);
  if (!probe?.installed) return ui`${agentLabel(agentId)}가 설치되어 있지 않습니다. 설정에서 연결 안내를 확인하세요.`;
  if (probe.loggedIn !== true && !(probe.agentId === "antigravity" && probe.loggedIn === null)) return ui`${agentLabel(agentId)} 로그인이 필요합니다. 설정에서 로그인 명령을 확인하세요.`;
  return "";
}

function renderAuxiliaryRunControls(): void {
  const runningKind = activeAuxiliaryKind();
  const translationBusy = aiStarting || aiRun?.state === "running";
  const auxiliaryBusy = runningKind !== null;
  const chatAgent = selectedChatAgent();
  const punctuationAgent = selectedPunctuationAgent();
  const chatCurrent = auxiliaryRun?.taskKind === "chat"
    && auxiliaryRun.documentNodeId === view?.document.id
    && runChatScope(auxiliaryRun) === selectedChatScope();
  const punctuationCurrent = auxiliaryRun?.taskKind === "punctuation_suggest"
    && auxiliaryRun.documentNodeId === view?.document.id;

  const chatSend = must<HTMLButtonElement>("#chatSend");
  const chatCancel = must<HTMLButtonElement>("#chatCancel");
  chatSend.disabled = !view
    || !must<HTMLTextAreaElement>("#chatInput").value.trim()
    || hasUnsavedChanges()
    || translationBusy
    || auxiliaryBusy
    || !agentReady(chatAgent);
  chatCancel.hidden = !(chatCurrent && auxiliaryRun?.state === "running");
  chatSend.hidden = !chatCancel.hidden;
  chatCancel.disabled = auxiliaryCanceling;
  chatCancel.textContent = auxiliaryCanceling ? t("취소 요청 중…") : t("취소");
  renderChatModelInfo();
  must("#chatModelInfo").title = must("#chatModelInfo").textContent ?? "";
  must<HTMLSelectElement>("#chatScope").disabled = auxiliaryBusy;
  must<HTMLTextAreaElement>("#chatInput").disabled = false;
  must("#chatRunStatus").textContent = chatCurrent && auxiliaryRun?.state === "completed" ? "" : auxiliaryStatus("chat", chatAgent);

  const punctuationButton = must<HTMLButtonElement>("#btnSuggestPunctuation");
  const punctuationCancel = must<HTMLButtonElement>("#btnCancelPunctuation");
  const punctuationRunning = auxiliaryStarting === "punctuation_suggest" || (punctuationCurrent && auxiliaryRun?.state === "running");
  const punctuationLocked = view?.punctuation?.state === "confirmed" && !punctuationEditingConfirmed;
  punctuationButton.hidden = punctuationLocked && !punctuationRunning;
  punctuationButton.disabled = !view || (!punctuationRunning && (punctuationLocked || view.source.state !== "confirmed" || punctuationApplying || hasUnsavedChanges() || translationBusy || auxiliaryBusy || editorMutationBusy()));
  punctuationButton.textContent = punctuationRunning ? t("진행 보기") : t("AI 표점 생성");
  const startPunctuation = must<HTMLButtonElement>("#punctuationPrepRun");
  startPunctuation.disabled = punctuationButton.disabled || punctuationRunning || !agentReady(punctuationAgent) || agentProbeLoading || prepSettingsPending > 0 || !!prepSettingsSaveError;
  startPunctuation.textContent = punctuationRunning ? t("생성 중…") : t("생성 시작");
  punctuationCancel.hidden = !(punctuationCurrent && auxiliaryRun?.state === "running");
  punctuationCancel.disabled = auxiliaryCanceling;
  punctuationCancel.textContent = auxiliaryCanceling ? t("취소 요청 중…") : t("취소");
  const punctuationAgentSelect = must<HTMLSelectElement>("#punctuationAgent");
  punctuationAgentSelect.disabled = auxiliaryBusy || (view?.punctuation?.state === "confirmed" && !punctuationEditingConfirmed);
  punctuationAgentSelect.title = punctuationAgentSelect.selectedOptions[0]?.title ?? "";
  must("#punctuationAiStatus").textContent = auxiliaryStatus("punctuation_suggest", punctuationAgent);
  renderPunctuationSuggestionPreview();
  renderPunctuationPreparationControls();
}

function previewedPunctuationSuggestion(): PunctuationSuggestionView | null {
  return punctuationPreviewing && punctuationSuggestion && punctuationSuggestion.documentNodeId === view?.document.id && !punctuationSuggestion.applied
    ? punctuationSuggestion
    : null;
}

function showPunctuationSuggestion(show: boolean): void {
  if (show === punctuationPreviewing) return;
  const textarea = must<HTMLTextAreaElement>("#punctuationDraftText");
  if (show) {
    if (!punctuationSuggestion || punctuationSuggestion.documentNodeId !== view?.document.id || punctuationSuggestion.applied) return;
    punctuationDraftBeforePreview = textarea.value;
  } else {
    if (punctuationDraftBeforePreview !== null) textarea.value = punctuationDraftBeforePreview;
    punctuationDraftBeforePreview = null;
  }
  punctuationPreviewing = show;
  renderDraftWorkspaces();
}

function renderPunctuationSuggestionPreview(): void {
  const preview = must<HTMLElement>("#punctuationProposal");
  const suggestion = punctuationSuggestion?.documentNodeId === view?.document.id ? punctuationSuggestion : null;
  const previewing = !!previewedPunctuationSuggestion();
  must("#punctuationTextSwitch").hidden = !suggestion || suggestion.applied;
  must("#btnViewPunctuationDraft").setAttribute("aria-pressed", String(!previewing));
  must("#btnViewPunctuationSuggestion").setAttribute("aria-pressed", String(previewing));
  must<HTMLButtonElement>("#btnViewPunctuationDraft").disabled = punctuationApplying;
  must<HTMLButtonElement>("#btnViewPunctuationSuggestion").disabled = punctuationApplying;
  preview.hidden = !previewing;
  if (!suggestion || !previewing) return;
  const badge = must("#punctuationProposalState");
  const apply = must<HTMLButtonElement>("#btnApplyPunctuationSuggestion");
  must("#punctuationProposalMeta").textContent = `${agentLabel(suggestion.agentId)} · ${suggestion.createdAt.slice(0, 16).replace("T", " ")}`;
  if (suggestion.validationState === "invalid_unapplied") {
    badge.className = "tag tag-danger";
    badge.textContent = t("원문·표점 형식 확인 실패 · 미적용");
    must("#punctuationProposalHelp").textContent = ui`${suggestion.validationError || t("원문 보존 또는 표점 형식 검사에 실패했습니다.")} 응답은 실행 이력에 보존됐습니다.`;
    apply.disabled = true;
    apply.textContent = t("적용할 수 없음");
    return;
  }
  badge.className = "tag tag-line";
  badge.textContent = t("원문 보존 확인 · 미적용");
  must("#punctuationProposalHelp").textContent = hasUnsavedChanges()
    ? t("작성하던 변경이 보존되어 있습니다. 작업안으로 돌아가 먼저 저장한 뒤 제안을 적용하세요.")
    : t("왼쪽 원문과 대조해 검토하세요. 적용하면 이 입력란에서 수정할 수 있습니다. 표점 해석의 정확성은 직접 확인하세요.");
  apply.disabled = (view?.punctuation?.state === "confirmed" && !punctuationEditingConfirmed)
    || punctuationApplying
    || hasUnsavedChanges()
    || activeAuxiliaryKind() !== null
    || aiStarting
    || aiRun?.state === "running";
  apply.textContent = punctuationApplying ? t("적용 중…") : t("제안 적용하고 편집");
}

function clearAuxiliaryPoll(): void {
  if (auxiliaryPollTimer === null) return;
  window.clearTimeout(auxiliaryPollTimer);
  auxiliaryPollTimer = null;
}

function scheduleAuxiliaryPoll(messageId: string): void {
  clearAuxiliaryPoll();
  if (auxiliaryRun?.messageId !== messageId || auxiliaryRun.state !== "running") return;
  auxiliaryPollTimer = window.setTimeout(() => {
    auxiliaryPollTimer = null;
    void pollAuxiliaryRun(messageId);
  }, 900);
}

async function pollAuxiliaryRun(messageId: string): Promise<void> {
  if (auxiliaryRun?.messageId !== messageId || auxiliaryRun.state !== "running") return;
  try {
    const result = await api.ai.get(messageId);
    if (!result.ok) {
      auxiliaryActionError = {
        kind: auxiliaryRun.taskKind as AuxiliaryTaskKind,
        ...result.error,
      };
      renderAuxiliaryRunControls();
      scheduleAuxiliaryPoll(messageId);
      return;
    }
    receiveAuxiliaryRun(result.data);
  } catch (error) {
    auxiliaryActionError = {
      kind: auxiliaryRun.taskKind as AuxiliaryTaskKind,
      code: "run_status_unavailable",
      message: error instanceof Error ? error.message : t("실행 상태를 확인하지 못했습니다."),
    };
    renderAuxiliaryRunControls();
    scheduleAuxiliaryPoll(messageId);
  }
}

function receiveAuxiliaryRun(next: AiRunView): void {
  if (next.taskKind === "translation") return;
  const nextKind = next.taskKind;
  if (auxiliaryRun && auxiliaryRun.messageId !== next.messageId) return;
  if (!auxiliaryRun && (
    auxiliaryStarting !== nextKind
    || next.documentNodeId !== view?.document.id
    || (nextKind === "chat" && runChatScope(next) !== selectedChatScope())
  )) return;
  if (auxiliaryRun && auxiliaryRun.state !== "running" && next.state === "running") return;

  auxiliaryRun = next;
  auxiliaryStarting = null;
  auxiliaryCanceling = next.state === "running" && next.phase === "stopping";
  auxiliaryActionError = null;
  renderChat();
  renderAuxiliaryRunControls();
  if (next.state === "running") {
    scheduleAuxiliaryPoll(next.messageId);
    return;
  }
  clearAuxiliaryPoll();
  if (!handledAuxiliaryTerminals.has(next.messageId) && !finalizingAuxiliaryTerminals.has(next.messageId)) {
    finalizingAuxiliaryTerminals.add(next.messageId);
    window.setTimeout(() => void finalizeAuxiliaryRun(next.messageId), 120);
  }
}

async function refreshChat(documentNodeId: string, scopeKind: ChatScopeKind): Promise<boolean> {
  if (view?.document.id !== documentNodeId) return false;
  const serial = ++chatLoadSerial;
  try {
    const result = await api.ai.getChat({ documentNodeId, scopeKind });
    if (!result.ok || serial !== chatLoadSerial || view?.document.id !== documentNodeId) return false;
    if (scopeKind === "project") projectChat = result.data;
    else view.chat = result.data;
    if (selectedChatScope() === scopeKind) renderChat();
    return true;
  } catch {
    // The full editor refresh or next open can recover the durable chat ledger.
    return false;
  }
}

async function loadPunctuationSuggestion(documentNodeId: string): Promise<void> {
  const previousMessageId = punctuationSuggestion?.messageId;
  try {
    const result = await api.ai.getPunctuationSuggestion(documentNodeId);
    if (view?.document.id !== documentNodeId) return;
    punctuationSuggestion = result.ok ? result.data : null;
  } catch {
    if (view?.document.id === documentNodeId) punctuationSuggestion = null;
  }
  if (view?.document.id !== documentNodeId) return;
  if (punctuationSuggestion && !punctuationSuggestion.applied && punctuationSuggestion.messageId !== previousMessageId && !hasUnsavedChanges()) {
    showPunctuationSuggestion(true);
  } else if (!punctuationSuggestion || punctuationSuggestion.applied) {
    showPunctuationSuggestion(false);
  }
  renderDraftWorkspaces();
}

async function finalizeAuxiliaryRun(messageId: string): Promise<void> {
  try {
    const result = await api.ai.get(messageId);
    if (result.ok && result.data.messageId === messageId && result.data.state !== "running") {
      auxiliaryRun = result.data;
      auxiliaryActionError = null;
    }
  } catch {
    // Keep the terminal push/poll result.
  }
  finalizingAuxiliaryTerminals.delete(messageId);
  const terminal = auxiliaryRun;
  if (!terminal || terminal.messageId !== messageId || terminal.state === "running" || terminal.taskKind === "translation") {
    if (terminal?.messageId === messageId) scheduleAuxiliaryPoll(messageId);
    return;
  }
  if (handledAuxiliaryTerminals.has(messageId)) return;
  handledAuxiliaryTerminals.add(messageId);

  if (terminal.taskKind === "chat") {
    const pending = pendingChatMessage?.messageId === messageId ? pendingChatMessage : null;
    if (pending) pendingChatMessage = null;
    const refreshed = await refreshChat(terminal.documentNodeId, runChatScope(terminal));
    if (!refreshed && pending) pendingChatMessage = pending;
  }
  renderChat();
  renderAuxiliaryRunControls();

  const title = terminal.taskKind === "chat" ? t("AI 채팅") : t("AI 표점 제안");
  if (terminal.state === "canceled") {
    notify(t("실행을 취소했습니다."), title);
    return;
  }
  if (terminal.state === "failed") {
    notify(actionableAiError(terminal.error ?? {
      code: "ai_run_failed",
      message: terminal.detail ?? t("AI 실행을 완료하지 못했습니다."),
    }), ui`${title} 실패`);
    return;
  }
  if (terminal.taskKind === "chat") {
    notify(t("답변과 실행 기록을 프로젝트에 저장했습니다."), title);
    return;
  }
  await loadPunctuationSuggestion(terminal.documentNodeId);
  if (terminal.validationState === "invalid_unapplied") {
    notify(punctuationSuggestion?.validationError || t("응답은 보존했지만 원문·표점 형식 검사에 실패해 적용하지 않았습니다."), title);
    return;
  }
  notify(t("표점 원문 입력란에서 AI 제안을 검토한 뒤 적용하세요."), title);
}

async function applyCurrentPunctuationSuggestion(): Promise<void> {
  const suggestion = punctuationSuggestion;
  if (!view || !suggestion || suggestion.documentNodeId !== view.document.id || suggestion.applied) return;
  if (view.punctuation?.state === "confirmed" && !punctuationEditingConfirmed) return;
  if (suggestion.validationState !== "valid") {
    notify(t("원문 보존 검증을 통과한 제안만 적용할 수 있습니다."), t("AI 표점 제안"));
    return;
  }
  if (hasUnsavedChanges()) {
    notify(t("편집 중인 변경을 먼저 저장한 뒤 제안을 적용하세요."), t("AI 표점 제안"));
    return;
  }
  punctuationApplying = true;
  auxiliaryActionError = null;
  renderAuxiliaryRunControls();
  try {
    const result = await api.ai.applyPunctuationSuggestion(suggestion.messageId);
    if (!result.ok) {
      auxiliaryActionError = { kind: "punctuation_suggest", ...result.error };
      notify(actionableAiError(result.error), t("표점 제안을 적용하지 못했습니다"));
      return;
    }
    punctuationSuggestion = { ...suggestion, ...result.data };
    await loadEditor(suggestion.documentNodeId);
    setWorkspace("punctuation");
    must<HTMLTextAreaElement>("#punctuationDraftText").focus();
    notify(t("새 표점 작업안으로 적용했습니다. 내용과 구조를 검토한 뒤 직접 확정하세요."), t("AI 표점 제안"));
  } catch (error) {
    auxiliaryActionError = {
      kind: "punctuation_suggest",
      code: "punctuation_apply_unavailable",
      message: error instanceof Error ? error.message : t("표점 제안을 적용하지 못했습니다."),
    };
    notify(auxiliaryActionError.message, t("표점 제안을 적용하지 못했습니다"));
  } finally {
    punctuationApplying = false;
    renderAuxiliaryRunControls();
  }
}

async function startProjectChat(): Promise<void> {
  if (!view || auxiliaryStarting || auxiliaryRun?.state === "running" || aiStarting || aiRun?.state === "running") return;
  const question = must<HTMLTextAreaElement>("#chatInput").value.trim();
  if (!question) return;
  if (hasUnsavedChanges()) {
    notify(t("편집 중인 변경을 먼저 저장한 뒤 채팅을 실행하세요."), t("AI 채팅"));
    return;
  }
  const agentId = selectedChatAgent();
  const scopeKind = selectedChatScope();
  lastChatRequest = { key: `${view.document.id}:${scopeKind}`, question };
  if (!agentReady(agentId)) {
    notify(ui`${agentLabel(agentId)}의 설치와 로그인을 설정에서 확인하세요.`, t("AI 채팅"));
    return;
  }
  auxiliaryRun = null;
  auxiliaryActionError = null;
  auxiliaryStarting = "chat";
  pendingChatMessage = {
    documentNodeId: view.document.id,
    scopeKind,
    text: question,
    createdAt: new Date().toISOString(),
    messageId: null,
  };
  chatSurface?.setDraft("");
  renderChat();
  chatSurface?.bottom();
  renderAuxiliaryRunControls();
  try {
    const result = await api.ai.startChat({ documentNodeId: view.document.id, scopeKind, question, agentId });
    if (!result.ok) {
      auxiliaryStarting = null;
      auxiliaryActionError = { kind: "chat", ...result.error };
      pendingChatMessage = null;
      if (!must<HTMLTextAreaElement>("#chatInput").value.trim()) chatSurface?.setDraft(question);
      renderChat();
      renderAuxiliaryRunControls();
      notify(actionableAiError(result.error), t("AI 채팅을 시작하지 못했습니다"));
      return;
    }
    if (pendingChatMessage) pendingChatMessage.messageId = result.data.messageId;
    receiveAuxiliaryRun(result.data);
  } catch (error) {
    auxiliaryStarting = null;
    auxiliaryActionError = {
      kind: "chat",
      code: "ai_start_unavailable",
      message: error instanceof Error ? error.message : t("AI 채팅을 시작하지 못했습니다."),
    };
    pendingChatMessage = null;
    if (!must<HTMLTextAreaElement>("#chatInput").value.trim()) chatSurface?.setDraft(question);
    renderChat();
    renderAuxiliaryRunControls();
    notify(auxiliaryActionError.message, t("AI 채팅을 시작하지 못했습니다"));
  }
}

function renderPunctuationPreparationSettings(): void {
  if (!appConfig) return;
  const selected = selectedPunctuationAgent();
  must("#punctuationModelSettings").innerHTML = prepModelMarkup(appConfig, agentProbe(selected), selected).replaceAll("prep-model-", "punctuation-model-");
  const preferences = appConfig.agentModels[selected];
  const model = agentProbe(selected)?.models.find(item => item.id === preferences.model)?.label;
  must("#punctuationPrepSummary").textContent = [agentLabel(selected).replace(" CLI", ""), preferences.model === "default" ? t("CLI 기본값") : model ?? preferences.model, preferences.reasoning].filter(Boolean).join(" · ");
}

function renderPunctuationPreparationControls(): void {
  const current = auxiliaryRun?.taskKind === "punctuation_suggest" && auxiliaryRun.documentNodeId === view?.document.id;
  const running = auxiliaryStarting === "punctuation_suggest" || (current && auxiliaryRun?.state === "running");
  const ready = punctuationSuggestion?.documentNodeId === view?.document.id && punctuationSuggestion?.validationState === "valid" && !punctuationSuggestion.applied && !running
    && (!current || punctuationSuggestion.messageId === auxiliaryRun?.messageId);
  renderPunctuationProgress(current ? auxiliaryRun : null, auxiliaryStarting === "punctuation_suggest", !!running);
  must("#punctuationPrepSpinner").hidden = !running;
  must("#punctuationPrepReview").hidden = !ready;
  must("#punctuationPrepClose").className = punctuationProgressMode && !ready ? "btn btn-primary" : "btn btn-ghost";
  must("#punctuationPrepRun").hidden = !!ready || punctuationProgressMode;
  must("#punctuationPrepConnection").textContent = agentProbeLoading ? t("연결 확인 중") : agentReady(selectedPunctuationAgent()) ? t("연결됨") : t("연결 확인 필요");
  const locked = activeAuxiliaryKind() !== null || aiStarting || aiRun?.state === "running";
  $$<HTMLSelectElement>("#punctuationModelSettings select").forEach(select => { select.disabled = locked || select.dataset.capabilityDisabled === "true"; });
  const note = must("#punctuationSettingsNote");
  note.textContent = prepSettingsSaveError ? t("AI 설정을 저장하지 못했습니다. 다시 시도해 주세요.") : prepSettingsPending ? t("설정 저장 중") : "";
  note.hidden = !note.textContent;
  must("#punctuationRetrySettings").hidden = !prepSettingsSaveError || prepSettingsPending > 0;
  must("#punctuationPrepFootnote").textContent = running ? t("닫아도 작업은 계속됩니다.") : ready ? t("생성된 제안을 원문과 대조하세요.") : t("검토 후 직접 확정합니다.");
}

function openPunctuationPreparation(): void {
  if (!view) return;
  const dialog = must<HTMLDialogElement>("#dlgPunctuation");
  must("#punctuationPrepTitle").textContent = view.document.originalTitle || view.document.title;
  must("#punctuationPrepSource").textContent = view.source.contentText;
  must("#punctuationPrepSourceInfo").textContent = ui`${fmt(codepointLength(view.source.contentText))}자 · ${must<HTMLSelectElement>("#punctuationMode").value === "poetry" ? t("운문") : t("산문")}`;
  renderPunctuationPreparationSettings();
  renderAuxiliaryRunControls();
  if (!dialog.open) dialog.showModal();
  void refreshAgentProbes();
}

async function startPunctuationSuggestion(): Promise<void> {
  if (prepSettingsPending > 0 || prepSettingsSaveError || agentProbeLoading || editorMutationBusy()) return;
  if (!view || auxiliaryStarting || auxiliaryRun?.state === "running" || aiStarting || aiRun?.state === "running") return;
  if (view.punctuation?.state === "confirmed" && !punctuationEditingConfirmed) return;
  if (view.source.state !== "confirmed") {
    notify(t("원문안을 먼저 확정하세요."), t("AI 표점 제안"));
    return;
  }
  if (hasUnsavedChanges()) {
    notify(t("편집 중인 변경을 먼저 저장한 뒤 표점을 요청하세요."), t("AI 표점 제안"));
    return;
  }
  const agentId = selectedPunctuationAgent();
  if (!agentReady(agentId)) {
    notify(ui`${agentLabel(agentId)}의 설치와 로그인을 설정에서 확인하세요.`, t("AI 표점 제안"));
    return;
  }
  auxiliaryRun = null;
  auxiliaryActionError = null;
  auxiliaryStarting = "punctuation_suggest";
  renderAuxiliaryRunControls();
  try {
    const result = await api.ai.startPunctuation({
      documentNodeId: view.document.id,
      structureMode: must<HTMLSelectElement>("#punctuationMode").value as "prose" | "poetry",
      agentId,
    });
    if (!result.ok) {
      auxiliaryStarting = null;
      auxiliaryActionError = { kind: "punctuation_suggest", ...result.error };
      renderAuxiliaryRunControls();
      notify(actionableAiError(result.error), t("AI 표점 제안을 시작하지 못했습니다"));
      return;
    }
    receiveAuxiliaryRun(result.data);
  } catch (error) {
    auxiliaryStarting = null;
    auxiliaryActionError = {
      kind: "punctuation_suggest",
      code: "ai_start_unavailable",
      message: error instanceof Error ? error.message : t("AI 표점 제안을 시작하지 못했습니다."),
    };
    renderAuxiliaryRunControls();
    notify(auxiliaryActionError.message, t("AI 표점 제안을 시작하지 못했습니다"));
  }
}

async function cancelAuxiliaryRun(): Promise<void> {
  if (!auxiliaryRun || auxiliaryRun.state !== "running" || auxiliaryCanceling) return;
  const messageId = auxiliaryRun.messageId;
  auxiliaryCanceling = true;
  auxiliaryActionError = null;
  renderAuxiliaryRunControls();
  try {
    const result = await api.ai.cancel(messageId);
    if (!result.ok) {
      auxiliaryCanceling = false;
      auxiliaryActionError = { kind: auxiliaryRun.taskKind as AuxiliaryTaskKind, ...result.error };
      renderAuxiliaryRunControls();
      notify(result.error.message, t("실행을 취소하지 못했습니다"));
      scheduleAuxiliaryPoll(messageId);
      return;
    }
    receiveAuxiliaryRun(result.data);
  } catch (error) {
    auxiliaryCanceling = false;
    auxiliaryActionError = {
      kind: auxiliaryRun.taskKind as AuxiliaryTaskKind,
      code: "ai_cancel_unavailable",
      message: error instanceof Error ? error.message : t("취소 요청을 전달하지 못했습니다."),
    };
    renderAuxiliaryRunControls();
    notify(auxiliaryActionError.message, t("실행을 취소하지 못했습니다"));
    scheduleAuxiliaryPoll(messageId);
  }
}

function blocksFrom(translation: NonNullable<EditorView["translation"]>): Block[] {
  return translation.blocks.map((b) => ({
    key: b.blockKey,
    anchors: [...b.sourceAnchorIds],
    relationKinds: [...b.relationKinds],
    text: b.translation,
    kind: b.blockKind,
  }));
}

function joinBlocks(bs: Block[]): string {
  return bs.map((b) => b.text).join(" ");
}

function editing(): boolean {
  return !!view?.translation
    && view.translation.isCurrentDependencies
    && view.translation.state !== "confirmed";
}

function editorMutationBusy(): boolean {
  return workspaceSaving || translationSaving || activeMutations.size > 0 || sentenceLinkUi.isBusy() || readingStudy.isBusy() || documentMaterials.isBusy();
}

function isSentenceEditing(sentenceId: string | undefined): boolean {
  if (!sentenceId || !editingSentenceId) return false;
  if (sentenceId === editingSentenceId) return true;
  const groupId = sentenceLinks.find(link => link.sentenceId === editingSentenceId)?.groupId;
  return !!groupId && sentenceLinks.some(link => link.sentenceId === sentenceId && link.groupId === groupId);
}

function renderEditingLocks(): void {
  if (!view) return;
  const busy = editorMutationBusy();
  const sourceLocked = view.source.state === "confirmed" && !sourceEditingConfirmed;
  const punctuationLocked = !!previewedPunctuationSuggestion() || !view.punctuation || view.punctuation.state === "superseded"
    || (view.punctuation.state === "confirmed" && !punctuationEditingConfirmed);
  must<HTMLButtonElement>("#btnEditPunctuation").disabled = busy || punctuationApplying;
  must<HTMLButtonElement>("#btnCancelPunctuationEdit").disabled = busy || punctuationApplying;
  must<HTMLTextAreaElement>("#sourceDraftText").readOnly = busy || sourceLocked;
  must<HTMLButtonElement>("#btnEditSource").disabled = busy;
  must<HTMLButtonElement>("#btnCancelSourceEdit").disabled = busy;
  must<HTMLTextAreaElement>("#punctuationDraftText").readOnly = busy || punctuationLocked;
  must<HTMLSelectElement>("#punctuationMode").disabled = busy || punctuationLocked;
  must<HTMLTextAreaElement>("#fullTranslationInput").readOnly = busy || !editing() || reviewComments.isSelecting();
  $$<HTMLTextAreaElement>("#rows .sentence-edit, #bookGroups textarea").forEach((el) => { el.readOnly = busy || !editing() || reviewComments.isSelecting() || !isSentenceEditing(el.dataset.sentenceEdit); });
  $$<HTMLButtonElement>("#rows [data-edit-sentence], #bookEditToolbar [data-edit-sentence]").forEach((button) => {
    button.disabled = busy || !editing() || reviewComments.isSelecting();
    const label = isSentenceEditing(button.dataset.editSentence) ? t("편집 마침") : t("편집");
    const caption = button.querySelector("[data-edit-caption]");
    if (caption) caption.textContent = label;
    else button.textContent = label;
    button.setAttribute("aria-pressed", String(isSentenceEditing(button.dataset.editSentence)));
  });
  $$<HTMLButtonElement>("#rows [data-split-group], #rows [data-merge-group], #bookEditToolbar [data-split-group], #bookEditToolbar [data-merge-group]").forEach(button => {
    button.disabled = busy || !editing() || reviewComments.isSelecting() || (button.hasAttribute("data-merge-group") && sentenceDrafts.at(-1)?.id === button.dataset.mergeGroup);
  });
  $$("#rows .tgt-edit").forEach((el) => { el.contentEditable = String(!busy && editing()); });
}

function shownBlocks(): Block[] {
  return blocks;
}

function markTerms(text: string): string {
  return termMarkup(text, Object.keys(terms), esc);
}

function validate(bs: Block[]): string[] {
  const issues: string[] = [];
  if (!view) return issues;
  if (view.translation?.textLayout) return must<HTMLTextAreaElement>("#fullTranslationInput").value.trim() ? [] : [t("번역 내용이 비어 있습니다")];
  const knownAnchors = new Set(view.anchors.map((a) => a.anchorKey));
  if (!bs.length) issues.push(t("번역 블록 없음 (empty_block)"));
  bs.forEach((b) => {
    if (!b.text.trim()) issues.push(ui`${b.key} 번역이 비어 있음 (empty_translation)`);
    if (!b.anchors.length) issues.push(ui`${b.key} 연결 앵커 없음 (empty_block)`);
    const blockSeen = new Set<string>();
    b.anchors.forEach((k) => {
      if (!knownAnchors.has(k)) issues.push(ui`${k} 현재 분절에 없는 앵커 (unknown_anchor)`);
      if (blockSeen.has(k)) issues.push(ui`${b.key} 안의 ${k} 중복 연결 (duplicate_anchor)`);
      blockSeen.add(k);
    });
  });
  return issues;
}

function inferRelationKind(bs: Block[], anchorKey: string): string {
  return bs.filter((block) => block.anchors.includes(anchorKey)).length > 1 ? "partial" : "full";
}

function quoteFor(key: string): string {
  const a = view?.anchors.find((x) => x.anchorKey === key);
  if (a?.punctuatedQuote) return a.punctuatedQuote;
  if (a && view?.punctuation?.punctuatedText) {
    return Array.from(view.punctuation.punctuatedText)
      .slice(a.punctuationFrom, a.punctuationTo)
      .join("");
  }
  return "";
}

function showsPunctuation(): boolean {
  return parallelSource === "punctuation" && !!punctuationProjection;
}

function displayedSource(span: { from: number; to: number; quote: string }) {
  if (showsPunctuation() && sourceCodepoints.slice(span.from, span.to).join("") === span.quote) {
    const projected = projectSourceRange(punctuationProjection!, span.from, span.to);
    if (projected) return projected;
  }
  return { text: span.quote, boundaries: null };
}

function renderParallelSourceHeading(): void {
  const select = must<HTMLSelectElement>("#parallelSource");
  const legacyFallback = !!view?.translation && !view.translation.textLayout && !punctuationProjection;
  select.value = showsPunctuation() ? "punctuation" : "source";
  select.disabled = legacyFallback;
  if (legacyFallback) select.value = "punctuation";
  select.options[1]!.disabled = !punctuationProjection;
  must("#parallelSourceGlyph").textContent = showsPunctuation() || legacyFallback ? "標點" : "原文";
  const status = must("#parallelSourceStatus");
  status.textContent = legacyFallback ? t("번역 당시 표점 구절") : showsPunctuation()
    ? `P${view!.punctuation!.versionNo} · ${VERSION_STATE_LABELS[view!.punctuation!.state]}`
    : !view?.punctuation ? t("표점 저장 후 전환 가능") : !punctuationProjection ? t("현재 원문에 맞는 표점 필요") : "";
  status.hidden = !status.textContent;
  select.title = showsPunctuation() ? t("저장된 표점문에서 연결 구절을 표시합니다.") : t("연결된 원문 구절을 표시합니다.");
}

function sourceSpanMarkup(span: { from: number; to: number; quote: string }): string {
  const display = displayedSource(span);
  const escapeText = (text: string) => esc(text).replaceAll("\r", "&#13;");
  const mapping = display.boundaries ? ` data-review-source-map="${escapeText(JSON.stringify(display.boundaries))}"` : "";
  return `<span data-review-source-from="${span.from}" data-review-source-to="${span.to}" data-review-source-quote="${escapeText(span.quote)}"${mapping}>${escapeText(display.text)}</span>`;
}

function parallelAnchor(key: string): string {
  const anchor = view?.anchors.find(item => item.anchorKey === key);
  if (!anchor || !punctuationProjection) return quoteFor(key);
  const boundaries = punctuationProjection.sourceBoundaryByPunctuationBoundary;
  const from = boundaries[anchor.punctuationFrom], to = boundaries[anchor.punctuationTo];
  if (from === undefined || to === undefined) return quoteFor(key);
  return showsPunctuation() ? quoteFor(key) : sourceCodepoints.slice(from, to).join("");
}

function renderSource(): void {
  must("#viewSource > p").textContent = view?.punctuation
    ? view.punctuation.state === "confirmed" ? t("확정 표점 원문") : t("표점 작업안")
    : t("원문");
  if (!view) return;
  const punctuation = view.punctuation;
  const spans = punctuation?.structureSpans ?? [];
  const firstAnchorForSpan = new Map<string, number>();
  for (const span of spans) {
    const index = view.anchors.findIndex(
      (anchor) => anchor.punctuationTo > span.codepointFrom && anchor.punctuationFrom < span.codepointTo,
    );
    if (index >= 0) firstAnchorForSpan.set(span.id, index);
  }
  const parts: string[] = [];
  view.anchors.forEach((a, i) => {
    const starting = spans
      .filter((span) => firstAnchorForSpan.get(span.id) === i)
      .sort((left, right) => left.codepointFrom - right.codepointFrom || right.codepointTo - left.codepointTo);
    for (const span of starting) {
      const rawKind = span.spanKind as StructureSpanKind;
      const kind = STRUCTURE_KIND_LABELS[rawKind] ?? span.spanKind;
      const label = span.label?.trim() || `${kind} ${span.ordinal}`;
      parts.push(
        `<span class="struct-label" title="${esc(`${span.codepointFrom}–${span.codepointTo} · ${span.spanKind}`)}">${esc(label)}</span>`,
      );
    }
    const hotCls = hot.includes(a.anchorKey) ? " is-hot" : "";
    parts.push(
      `<span class="anchor${hotCls}" data-key="${esc(a.anchorKey)}" tabindex="0"><sup class="anchor-key">${esc(a.anchorKey)}</sup>${markTerms(quoteFor(a.anchorKey))}</span>`,
    );
  });
  if (!view.anchors.length) {
    if (spans.length) {
      parts.push(
        `<div class="structure-summary">${spans.map((span) => `<span class="struct-label">${esc(span.label?.trim() || `${STRUCTURE_KIND_LABELS[span.spanKind as StructureSpanKind] ?? span.spanKind} ${span.ordinal}`)}</span>`).join("")}</div>`,
      );
    }
    parts.push(markTerms(punctuation?.punctuatedText || view.source.contentText));
  }
  must("#sourceText").innerHTML = parts.join("");
}

let sentenceSelection: ReturnType<typeof configureSentenceSelection> | undefined;
function syncSentenceSelection(): void {
  sentenceSelection ??= configureSentenceSelection();
  sentenceSelection.sync(`${view?.document.id ?? ""}:${view?.translation?.versionId ?? ""}`,
    workspace === "translation" && layout === "parallel" && !!view?.translation);
}

function renderRows(): void {
  renderParallelSourceHeading();
  const textLayout=view?.translation?.textLayout;
  if(textLayout) {
    const groups: Array<{ key: string; sentences: typeof sentenceDrafts }> = [];
    const byGroup = new Map<string, typeof groups[number]>();
    for (const sentence of sentenceDrafts) {
      const link = sentenceLinks.find(item => item.sentenceId === sentence.id);
      const key = link?.groupId ?? `sentence:${sentence.id}`;
      let group = byGroup.get(key);
      if (!group) { group = { key, sentences: [] }; byGroup.set(key, group); groups.push(group); }
      group.sentences.push(sentence);
    }
    const canLink = !!view?.translation?.isCurrentDependencies && !dirty && !translationSaving && textLayout.state !== "running";
    must("#rows").innerHTML = groups.map((group, index) => {
      const first = group.sentences[0]!;
      const link = sentenceLinks.find(item => item.sentenceId === first.id);
      const source = link?.spans.map(sourceSpanMarkup).join(" ") || uiText('<span class="unlinked-source">원문 구절을 연결해 대조하세요.</span>');
      const relation = link?.spans.length ? ui`연결 묶음 · 번역 ${group.sentences.length}구간` : t("미연결");
      const targets = group.sentences.map(sentence => {
        const link = sentenceLinks.find(item => item.sentenceId === sentence.id);
        return `<div class="sentence-group-member" data-review-sentence="${esc(sentence.id)}"><textarea class="sentence-edit" data-sentence-edit="${esc(sentence.id)}" aria-label="${esc(sentence.id)} 번역문" aria-describedby="translationEditHelp" spellcheck="false" rows="1"${!editing() || editorMutationBusy() || reviewComments.isSelecting() || !isSentenceEditing(sentence.id) ? " readonly" : ""}>${esc(sentence.text)}</textarea><div class="sentence-actions"><span data-sentence-review="${esc(sentence.id)}" class="sentence-state"${link?.spans.length && !link.needsReview && link.reviewedBy !== "human" ? " hidden" : ""}>${!link?.spans.length || link.needsReview ? t("대응 확인 필요") : link.reviewedBy === "human" ? t("대응 확인됨") : ""}</span><span data-review-row-count></span></div></div>`;
      }).join("");
      const bookmarkMenu = group.sentences.map((sentence, i) => editorAids.bookmarkMarkup(sentence.id, group.sentences.length > 1 ? i + 1 : undefined)).join("");
      const bookmarkIndicators = group.sentences.filter(sentence => editorAids.isBookmarked(sentence.id)).map(sentence => editorAids.bookmarkMarkup(sentence.id, group.sentences.length > 1 ? group.sentences.indexOf(sentence) + 1 : undefined)).join("");
      return `<article class="brow sentence-group" data-sentence-group="${esc(group.key)}" aria-label="${esc(group.sentences.map(sentence => sentence.id).join(", "))}"><div class="sentence-selection-cell"></div><div class="bcell bcell-src"><div class="bmeta"><span class="sentence-number">${String(index + 1).padStart(2, "0")}</span><span class="sentence-relation">${relation}</span></div><div class="sentence-source">${source}</div></div><div class="bcell bcell-tgt">${targets}<div class="sentence-actions sentence-group-actions">${bookmarkIndicators}<details class="book-group-menu sentence-group-menu"><summary aria-label="${esc(t("묶음 작업"))}" title="${esc(t("묶음 작업"))}">⋯</summary><div class="book-group-menu-items"><button class="btn btn-ghost btn-sm" type="button" data-edit-sentence-link="${esc(first.id)}"${canLink ? "" : " disabled"}>${link?.spans.length ? t("대응 확인·수정") : t("원문 연결")}</button>${groupActions(first.id)}${bookmarkMenu}</div></details><button class="btn btn-ghost btn-sm" type="button" data-edit-sentence="${esc(first.id)}" aria-pressed="${isSentenceEditing(first.id)}"${!editing() || editorMutationBusy() || reviewComments.isSelecting() ? " disabled" : ""}>${isSentenceEditing(first.id) ? t("편집 마침") : t("편집")}</button></div></div></article>`;
    }).join("");
    renderComparisonState();
    must("#blockCount").textContent=String(groups.length);
    resizeSentenceEditors();
    reviewComments.refresh();
    return;
  }
  const bs = shownBlocks();
  const can = editing();
  const rows = must("#rows");
rows.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  rows.querySelectorAll<HTMLDetailsElement>(".sentence-group-menu[open]").forEach(menu => {
    menu.open = false;
    menu.querySelector<HTMLElement>("summary")?.focus();
  });
});
  rows.setAttribute("aria-busy", String(blockOrderSaving));
  rows.innerHTML = bs
    .map((b, i) => {
      const isHot = b.anchors.some((k) => hot.includes(k));
      const src = b.anchors.map(parallelAnchor).join("");
      const orderDisabled = !can || blockOrderSaving;
      const upDisabled = orderDisabled || i === 0;
      const downDisabled = orderDisabled || i === bs.length - 1;
      return ui`<article class="brow${active === b.key ? " is-active" : ""}${isHot ? " is-hot" : ""}" data-key="${esc(b.key)}" data-i="${i}">
      <div class="bcell bcell-src"><div class="bmeta"><span class="bkey">${esc(b.key)}</span>${b.anchors.map((k) => `<span class="akey${hot.includes(k) ? " is-hot" : ""}" data-akey="${esc(k)}">${esc(k)}</span>`).join("")}</div><div>${markTerms(src)}</div></div>
      <div class="bcell bcell-tgt"><div class="bmeta"><span class="tag tag-plain">${esc(b.kind || "paragraph")}</span>${can ? "" : uiText('<span class="tag tag-line">읽기 전용</span>')}<span class="sp"></span><span class="block-order" role="group" aria-label="${esc(b.key)} 블록 순서 변경"><button type="button" data-move="up" data-move-i="${i}" aria-label="${esc(b.key)} 블록을 위로 이동" title="위로 이동 (⌥⌘↑)"${upDisabled ? " disabled" : ""}><span aria-hidden="true">↑</span></button><button type="button" data-move="down" data-move-i="${i}" aria-label="${esc(b.key)} 블록을 아래로 이동" title="아래로 이동 (⌥⌘↓)"${downDisabled ? " disabled" : ""}><span aria-hidden="true">↓</span></button></span><button class="more" data-more="${i}" type="button" aria-label="${esc(b.key)} 블록 동작 메뉴" title="블록 동작 (우클릭)">⋯</button></div>
        <div class="tgt-edit" contenteditable="${can}" spellcheck="false" data-edit="${esc(b.key)}">${esc(b.text)}</div></div>
    </article>`;
    })
    .join("");
  must("#blockCount").textContent = String(bs.length);
  syncSentenceSelection();
}

function sentenceNeedsReview(id: string): boolean {
  const link = sentenceLinks.find((item) => item.sentenceId === id);
  return !link?.spans.length || link.needsReview;
}

function renderComparisonState(): void {
  const whole = !!view?.translation?.textLayout;
  must(".editor-commandbar .comparison-tools").hidden = !whole;
  if (!whole) { must("#comparisonEmpty").hidden = true; syncSentenceSelection(); return; }
  const only = must<HTMLInputElement>("#alignmentReviewOnly").checked;
  const visible = comparisonSentences();
  renderComparisonFilterButton();
  if (!visible.some((sentence) => sentence.id === selectedSentenceId)) selectedSentenceId = visible[0]?.id ?? null;
  const selected = sentenceLinks.find((link) => link.sentenceId === selectedSentenceId);
  const sameSource = (id: string) => {
    const link = sentenceLinks.find((item) => item.sentenceId === id);
    return !!selected?.spans.length && JSON.stringify(link?.spans) === JSON.stringify(selected.spans);
  };
  $$("#rows [data-review-sentence]").forEach((row) => {
    const id = row.dataset.reviewSentence!;
    const group = row.closest<HTMLElement>("[data-sentence-group]");
    const members = group ? Array.from(group.querySelectorAll<HTMLElement>("[data-review-sentence]")) : [row];
    row.hidden = !members.some(member => visible.some(sentence => sentence.id === member.dataset.reviewSentence));
    row.classList.toggle("is-active", id === selectedSentenceId);
    row.classList.toggle("is-related", id !== selectedSentenceId && sameSource(id));
    const label = row.querySelector<HTMLElement>("[data-sentence-review]");
    const link = sentenceLinks.find((item) => item.sentenceId === id);
    if (label) { label.textContent = sentenceNeedsReview(id) ? t("대응 확인 필요") : link?.reviewedBy === "human" ? t("대응 확인됨") : ""; label.hidden = !label.textContent; }
    const button = row.querySelector<HTMLButtonElement>("[data-edit-sentence-link]");
    if (button) button.disabled = dirty || editorMutationBusy() || !view?.translation?.isCurrentDependencies || view.translation.textLayout?.state === "running";
  });
  $$("#rows [data-sentence-group]").forEach(group => {
    const members = Array.from(group.querySelectorAll<HTMLElement>("[data-review-sentence]"));
    group.hidden = members.every(member => member.hidden);
    group.classList.toggle("is-active", members.some(member => member.dataset.reviewSentence === selectedSentenceId));
    const button = group.querySelector<HTMLButtonElement>("[data-edit-sentence-link]");
    if (button) button.disabled = dirty || editorMutationBusy() || !view?.translation?.isCurrentDependencies || view.translation.textLayout?.state === "running";
  });
  const pending = sentenceDrafts.filter((sentence) => sentenceNeedsReview(sentence.id)).length;
  must("#comparisonSummary").textContent = pending
    ? ui`번역 ${sentenceDrafts.length}문장 · 대응 확인 필요 ${pending}`
    : ui`번역 문장 연결 ${sentenceDrafts.length}/${sentenceDrafts.length}`;
  const alignment = view?.translation?.textLayout;
  if (alignment?.state === "running") must("#comparisonSummary").textContent = t("원문 연결 중");
  else if (alignment?.state === "failed") must("#comparisonSummary").textContent = [t("원문 연결 실패 · 번역은 보존됨"), alignment.error].filter(Boolean).join(" · ");
  else if (alignment?.error) must("#comparisonSummary").textContent += ` · ${alignment.error}`;
  must("#comparisonEmpty").hidden = visible.length > 0;
  must("#comparisonEmpty").textContent = sentenceDrafts.length ? t("검색·필터 조건에 맞는 문장이 없습니다.") : t("서책 보기에서 번역을 입력하면 문장별로 대조할 수 있습니다.");
  const index = visible.findIndex((sentence) => sentence.id === selectedSentenceId);
  must<HTMLButtonElement>("#btnPreviousSentence").disabled = index <= 0;
  must<HTMLButtonElement>("#btnNextSentence").disabled = index < 0 || index >= visible.length - 1;
  syncSentenceSelection();
}

function moveSentence(direction: -1 | 1): void {
  const only = must<HTMLInputElement>("#alignmentReviewOnly").checked;
  const visible = comparisonSentences();
  const index = visible.findIndex((sentence) => sentence.id === selectedSentenceId);
  selectedSentenceId = visible[index + direction]?.id ?? selectedSentenceId;
  renderComparisonState();
  const row = $$("#rows [data-review-sentence]").find((item) => item.dataset.reviewSentence === selectedSentenceId);
  row?.scrollIntoView({ block: "nearest" });
  row?.querySelector<HTMLTextAreaElement>(".sentence-edit")?.focus({ preventScroll: true });
}

function resizeSentenceEditor(editor: HTMLTextAreaElement): void {
  if (!editor.getClientRects().length) return;
  const pane = editor.closest<HTMLElement>(".folio-translation, .pane-scroll"), top = pane?.scrollTop;
  editor.style.height = "0px";
  editor.style.height = `${editor.scrollHeight}px`;
  if (pane && top !== undefined) pane.scrollTop = top;
}

function resizeSentenceEditors(): void {
  $$<HTMLTextAreaElement>("#rows .sentence-edit, #bookGroups textarea").forEach(resizeSentenceEditor);
}

function groupActions(id: string): string {
  if (!sentenceLinks.find(link => link.sentenceId === id)?.groupId) return "";
  return `<button type="button" class="btn btn-ghost btn-sm" data-split-group="${esc(id)}">묶음 나누기</button><button type="button" class="btn btn-ghost btn-sm" data-merge-group="${esc(id)}"${sentenceDrafts.at(-1)?.id === id ? " disabled" : ""}>다음 묶음과 합치기</button>`;
}

function renderBookGroups(): void {
  const root = must("#bookGroups");
  root.hidden = !view?.translation?.textLayout;
  const toolbar = must("#bookEditToolbar");
  toolbar.hidden = root.hidden || (!sentenceDrafts.length && view?.project.storageMode !== "local");
  if (toolbar.hidden) return;
  root.classList.toggle("is-editing", !!editingSentenceId);
  must<HTMLSelectElement>("#bookSourceMode").value = showsPunctuation() ? "punctuation" : "source";
  must<HTMLSelectElement>("#bookSourceMode").options[1]!.disabled = !punctuationProjection;
  const edited = sentenceDrafts.find(sentence => sentence.id === editingSentenceId);
  const editedLink = edited && sentenceLinks.find(link => link.sentenceId === edited.id);
  const card: BookEditCard | null = edited ? {
    before: (savedGroupTexts.get(edited.id) ?? edited.text).replace(/\r\n?/g, "\n"),
    after: edited.text.replace(/\r\n?/g, "\n"),
    position: `${String(sentenceDrafts.indexOf(edited) + 1).padStart(2, "0")} / ${sentenceDrafts.length}`,
    review: !editedLink ? null : sentenceNeedsReview(edited.id) ? "needed" : "done",
    canSplit: !!editedLink?.groupId,
    collapsed: bookEditCollapsed,
    locked: !editing() || editorMutationBusy() || reviewComments.isSelecting(),
  } : null;
  const gapChosen = canEditBookGaps() ? selectedGapId : null;
  if (renderBookFlow(root, translationDraftText, sentenceDrafts, gapChosen ? null : selectedSentenceId, editingSentenceId, card)) {
    delete toolbar.querySelector<HTMLElement>(".book-group-menu")!.dataset.sentence;
  }
  root.querySelectorAll<HTMLTextAreaElement>("textarea:not([hidden])").forEach(resizeSentenceEditor);
  // A break that is gone or no longer editable hands the selection back to the paragraph above it.
  if (!markBookGap(root, gapChosen) && selectedGapId) { releaseBookGap(); return; }
  // While a paragraph break is chosen no group is, so the group tools step aside.
  toolbar.querySelectorAll<HTMLElement>(".book-group-position, .book-edit-state, [data-edit-sentence], .book-bookmark-indicator, details").forEach(el => { el.hidden = !sentenceDrafts.length || (!!selectedGapId && !el.matches(".book-edit-state")); });
  if (selectedGapId) { toolbar.querySelector(".book-edit-state")!.textContent = t("문단 나눔"); return; }
  const current = sentenceDrafts.find(sentence => sentence.id === selectedSentenceId) ?? sentenceDrafts[0];
  if (current) {
    toolbar.querySelector(".book-group-position")!.textContent = `${String(sentenceDrafts.indexOf(current) + 1).padStart(2, "0")} / ${sentenceDrafts.length}`;
    toolbar.querySelector(".book-edit-state")!.textContent = isSentenceEditing(current.id) ? "편집 중" : sentenceNeedsReview(current.id) ? "대응 확인 필요" : "";
    const edit = toolbar.querySelector<HTMLButtonElement>("[data-edit-sentence]")!;
    edit.dataset.editSentence = current.id;
    edit.disabled = !editing() || editorMutationBusy() || reviewComments.isSelecting();
    edit.setAttribute("aria-pressed", String(isSentenceEditing(current.id)));
    edit.querySelector("[data-edit-caption]")!.textContent = isSentenceEditing(current.id) ? "편집 마침" : "편집";
    toolbar.querySelector(".book-bookmark-indicator")!.innerHTML = editorAids.isBookmarked(current.id) ? editorAids.bookmarkMarkup(current.id) : "";
    const menu = toolbar.querySelector<HTMLDetailsElement>("details")!;
    if (menu.dataset.sentence !== current.id) {
      menu.open = false; menu.dataset.sentence = current.id;
      menu.querySelector(".book-group-menu-items")!.innerHTML = editorAids.bookmarkMarkup(current.id) + groupActions(current.id);
    }
    menu.hidden = false;
    menu.querySelectorAll<HTMLButtonElement>("button:not([data-editor-bookmark])").forEach(button => { button.disabled = !editing() || editorMutationBusy() || reviewComments.isSelecting() || (button.hasAttribute("data-merge-group") && current.id === sentenceDrafts.at(-1)?.id); });
  }
}

function sentenceForSourceIndex(index: number): string | null {
  for (const link of sentenceLinks) {
    if (link.spans.some(span => index >= span.from && index < span.to)) return link.sentenceId;
  }
  return null;
}

function highlightBookSource(id: string): void {
  if (!view) return;
  if (selectedGapId) id = "";
  const source = showsPunctuation() ? view.punctuation!.punctuatedText : view.source.contentText;
  const points = Array.from(source);
  const mapping = showsPunctuation() ? punctuationProjection!.sourceBoundaryByPunctuationBoundary : null;
  const owners = showsPunctuation() ? punctuationProjection!.sourceOwnerByPunctuationCodepoint : null;
  let html = "";
  let open: string | null = null;
  const close = () => { if (open !== null) { html += "</span>"; open = null; } };
  points.forEach((char, index) => {
    const sentenceId = sentenceForSourceIndex(owners ? owners[index]! : index);
    if (sentenceId !== open) {
      close();
      if (sentenceId) {
        const selected = sentenceId === id;
        html += `<span class="book-source-row${selected ? " book-source-highlight" : ""}" data-book-source="${esc(sentenceId)}" role="button" tabindex="0"${selected ? ' aria-current="true"' : ""}>`;
        open = sentenceId;
      }
    }
    html += esc(char);
  });
  close();
  const sourceElement = must("#folioSourceText");
  sourceElement.innerHTML = html;
  sourceElement.dataset.reviewSourceFrom = "0";
  sourceElement.dataset.reviewSourceTo = String(sourceCodepoints.length);
  sourceElement.dataset.reviewSourceQuote = view.source.contentText;
  if (mapping) sourceElement.dataset.reviewSourceMap = JSON.stringify(mapping);
  else delete sourceElement.dataset.reviewSourceMap;
  must("#folioSourceLabel").textContent = showsPunctuation() ? t("확정 표점 원문") : t("원문");
}

function renderFull(): void {
  documentFind.refresh();
  const whole=!!view?.translation?.textLayout;
  renderSaveState();
  renderComparisonState();
  editorAids.checkpoint();
  renderBookGroups();
  reviewComments.refresh();
  must<HTMLTextAreaElement>("#fullTranslationInput").readOnly=!editing() || translationSaving;
  renderEditingLocks();
  must("#translationEditHelp").hidden=!whole;
  must("#translationEditHelp").textContent=editing()
    ? t("문장별 ‘편집’을 눌러 수정하세요. 번역 저장 또는 ⌘S로 저장합니다.")
    : t("읽기 전용 번역입니다. 확정본은 ‘새 번역안으로 수정’을 눌러 편집하세요.");
  must("#fullText").hidden=whole;
  must("#btnSaveFullTranslation").hidden = !whole;
  must("#btnRetryAlignment").hidden = !whole;
  must<HTMLInputElement>("#chkStruct").closest("label")!.hidden=whole;
  must<HTMLInputElement>("#chkKeys").closest("label")!.hidden=whole;
  must("#legacyTranslationCounts").hidden=whole;
  must("#validBadge").hidden=whole;
  if(whole) {
    must<HTMLButtonElement>("#btnSaveFullTranslation").disabled=!editing()||!dirty||translationSaving;
    must("#btnSaveFullTranslation").textContent=translationSaving ? t("저장 중…") : dirty ? t("저장") : t("저장됨");
    must("#btnSaveFullTranslation").classList.toggle("is-saved", !dirty && !translationSaving);
    must("#btnRetryAlignment").textContent=view!.translation!.textLayout!.state==="running" ? t("원문 연결 중") : view!.translation!.textLayout!.state==="pending" ? t("원문 연결") : t("원문 다시 연결");
    must<HTMLButtonElement>("#btnRetryAlignment").disabled=!view?.translation?.textContent.trim()||dirty||aiRun?.state==="running"||view?.translation?.textLayout?.state==="running"||!view?.translation?.isCurrentDependencies;
    return;
  }
  must("#fullText").innerHTML = shownBlocks()
    .map(
      (b) =>
        `<span class="blk${b.anchors.some((k) => hot.includes(k)) ? " is-hot" : ""}" data-key="${esc(b.key)}">${esc(b.text)}</span>`,
    )
    .join(" ");
}

function renderStrip(): void {
  const bs = shownBlocks();
  const vs = must<HTMLElement>("#vstrip");
  const translation = view?.translation;
  if (!translation?.isCurrentDependencies) {
    vs.hidden = true;
    must<HTMLButtonElement>("#btnConfirm").hidden = true;
    must<HTMLButtonElement>("#btnRevise").hidden = true;
    return;
  }
  vs.hidden = false;
  const issues = validate(bs);
  const ok = issues.length === 0;
  vs.classList.toggle("is-bad", !ok);
  vs.innerHTML = view?.translation?.textLayout ? uiText(`<span class="tag tag-ok">번역 전문</span><span>문단과 줄바꿈 보존 · 원문 연결은 별도 검토</span>`) : ok
    ? ui`<span class="tag tag-ok">valid</span><span>저장 형식·현재 분절 참조 이상 없음</span><i class="sep"></i><span class="muted">원문 대응은 사용자가 검토 · 블록 ${bs.length}개 · v${translation.versionNo}</span>`
    : ui`<span class="tag tag-warn">needs_review</span><span>${issues.length}건 — ${esc(issues[0] ?? "")}${issues.length > 1 ? t(" 외") : ""}</span><i class="sep"></i><span class="muted">형식 또는 현재 분절 참조를 고쳐 새 valid 번역안을 만들기 전에는 확정할 수 없습니다</span>`;
  const sb = must("#stateBadge");
  const vb = must("#validBadge");
  const confirmed = translation.state === "confirmed";
  const label = confirmed ? ui`확정 v${translation.versionNo}` : ui`번역안 v${translation.versionNo}`;
  if (confirmed) {
    sb.className = "tag tag-ok";
  } else {
    sb.className = "tag tag-draft";
  }
  sb.textContent = label;
  vb.className = ok ? "tag tag-plain" : "tag tag-warn";
  vb.textContent = ok ? "valid" : "needs_review";
  const docTitle = view?.document.originalTitle || view?.document.title || t("문서");
  must("#titleDoc").textContent = docTitle;
  must("#titleSub").textContent = `— ${label}`;
  document.title = ui`${docTitle} — 문해 Munhae Studio`;
  must("#sbValid").innerHTML = view?.translation?.textLayout ? ui`번역 ${view.translation.textLayout.sentences.length}문장` : ui`<span class="tag ${ok ? "tag-ok" : "tag-warn"}" style="height:16px;font-size:10.5px">${ok ? "valid" : "needs_review"}</span> 블록 ${bs.length}`;
  const bc = must<HTMLButtonElement>("#btnConfirm");
  const br = must<HTMLButtonElement>("#btnRevise");
  bc.hidden = confirmed;
  br.hidden = !confirmed;
  bc.disabled = !ok;
  bc.title = !ok
    ? t("needs_review 상태에서는 확정할 수 없습니다")
    : t("번역안 확정 (⇧⌘↩)");
}

function renderHistory(): void {
  const kind = historyKind();
  renderVersionHistory(kind, kind === "translation" ? "translation" : null);
}

function historyKind(): "source" | "punctuation" | "translation" {
  return workspace === "terms" ? "source" : workspace === "segmentation" ? "punctuation" : workspace;
}

let lastChatRequest: { key: string; question: string } | null = null;
let chatSurface: ReturnType<typeof configureChatSurface> | null = null;
const chatDisclosureOverrides = new Map<string, boolean>();
const chatActivityTiming = new Map<string, { startedAt: string; completedAt: string | null }>();
const chatThinkingHistory = new Map<string, string>();
const chatActivityHistory = new Map<string, NonNullable<import("../../shared/munhae-api").AiRunView["activity"]>>();

function renderChat(): void {
  const list = must("#chatList");
  chatSurface ??= configureChatSurface(list, must<HTMLTextAreaElement>("#chatInput"), {
    key: () => view ? `${view.document.id}:${selectedChatScope()}` : "",
    messages: () => {
      const messages = selectedChatScope() === "project" ? projectChat : (view?.chat ?? []);
      const pending = pendingChatMessage?.documentNodeId === view?.document.id && pendingChatMessage?.scopeKind === selectedChatScope() ? pendingChatMessage : null;
      return [...messages, ...(pending ? [{ role: "user" as const, text: pending.text }] : [])];
    },
    changed: renderAuxiliaryRunControls,
    retry: () => {
      const messages = selectedChatScope() === "project" ? projectChat : (view?.chat ?? []);
      const lastQuestion = lastChatRequest?.key === `${view?.document.id}:${selectedChatScope()}` ? lastChatRequest.question : [...messages].reverse().find(message => message.role === "user")?.text;
      if (lastQuestion) { chatSurface!.setDraft(lastQuestion); void startProjectChat(); }
    },
  });
  chatSurface.sync();
  if (!list.dataset.activityDisclosureBound) {
    list.dataset.activityDisclosureBound = "true";
    list.addEventListener("click", event => {
      const summary = (event.target as Element).closest("summary");
      const details = summary?.parentElement as HTMLDetailsElement | undefined;
      const key = details?.dataset.thinkingKey;
      if (key && details) {
        chatDisclosureOverrides.set(key, !details.open);
        if (chatDisclosureOverrides.size > 500) chatDisclosureOverrides.delete(chatDisclosureOverrides.keys().next().value!);
      }
    });
  }
  const restoreChatScroll = chatSurface.captureScroll();
  const scopeKind = selectedChatScope();
  const msgs = scopeKind === "project" ? projectChat : (view?.chat ?? []);
  const projectScope = scopeKind === "project";
  const pending = pendingChatMessage
    && pendingChatMessage.documentNodeId === view?.document.id
    && pendingChatMessage.scopeKind === scopeKind
      ? pendingChatMessage
      : null;
  const isGenerating = auxiliaryStarting === "chat"
    || (auxiliaryRun?.taskKind === "chat"
      && auxiliaryRun.state === "running"
      && auxiliaryRun.documentNodeId === view?.document.id
      && runChatScope(auxiliaryRun) === scopeKind);
  must("#chatScopeNote").textContent = projectScope
    ? t("요청 본문에는 프로젝트 제목·문서 목록/상태·프로젝트 공통 문맥만 포함합니다. 문서 원문은 포함하지 않습니다.")
    : t("현재 문서의 원문·표점·현재 번역을 전송합니다. 번역 데이터는 변경하지 않습니다.");
  must<HTMLTextAreaElement>("#chatInput").placeholder = projectScope
    ? t("프로젝트 구성이나 진행 상태에 대해 질문하세요")
    : t("이 문서에 대해 질문하거나 검토를 요청하세요");
  const visibleMessages = pending
    ? [...msgs, { role: "user" as const, text: pending.text, createdAt: pending.createdAt }]
    : msgs;
  const thinkingOpenKeys = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>("details.chat-thinking[open]")).map(el => el.dataset.thinkingKey));
  const thinkingOpen = !!auxiliaryRun && thinkingOpenKeys.has(auxiliaryRun.messageId);
  let currentThinking = auxiliaryRun?.taskKind === "chat"
    && auxiliaryRun.documentNodeId === view?.document.id
    && runChatScope(auxiliaryRun) === scopeKind
    ? (auxiliaryRun.activity?.length ? chatActivityMarkup(auxiliaryRun.activity, auxiliaryRun.messageId, new Set(), undefined, { state: auxiliaryRun.state, startedAt: auxiliaryRun.startedAt, completedAt: auxiliaryRun.completedAt, overrides: chatDisclosureOverrides }) : thinkingMarkup(auxiliaryRun.thinkingText, auxiliaryRun.messageId, thinkingOpen)) : "";
  const lastMessage = visibleMessages.at(-1);
  const historyKey = (m: { createdAt: string; text: string }) => `${view?.document.id}:${scopeKind}:${m.createdAt}`;
  if (lastMessage?.role === "assistant" && auxiliaryRun?.state === "completed"
      && currentThinking && auxiliaryRun.partialText === lastMessage.text) {
    if (auxiliaryRun.activity?.length) {
      chatActivityHistory.set(historyKey(lastMessage), auxiliaryRun.activity.map(block => ({ ...block })));
      chatActivityTiming.set(historyKey(lastMessage), { startedAt: auxiliaryRun.startedAt, completedAt: auxiliaryRun.completedAt });
      for (const [key, open] of [...chatDisclosureOverrides]) if (key.startsWith(`${auxiliaryRun.messageId}:`)) chatDisclosureOverrides.set(key.replace(auxiliaryRun.messageId, historyKey(lastMessage)), open);
      if (chatActivityTiming.size > 50) chatActivityTiming.delete(chatActivityTiming.keys().next().value!);
      for (const key of thinkingOpenKeys) if (key?.startsWith(`${auxiliaryRun.messageId}:`)) thinkingOpenKeys.add(key.replace(auxiliaryRun.messageId, historyKey(lastMessage)));
      if (chatActivityHistory.size > 50) chatActivityHistory.delete(chatActivityHistory.keys().next().value!);
    } else chatThinkingHistory.set(historyKey(lastMessage), auxiliaryRun.thinkingText!);
    if (thinkingOpen) thinkingOpenKeys.add(historyKey(lastMessage));
    if (chatThinkingHistory.size > 50) chatThinkingHistory.delete(chatThinkingHistory.keys().next().value!);
    currentThinking = "";
  }
  const rendered = visibleMessages
    .map((m, index) => {
      const when = m.createdAt.length >= 16 ? m.createdAt.slice(11, 16) : m.createdAt;
      if (m.role === "user") {
        return chatMessageMarkup({ role: "user", text: m.text, time: when }, index);
      }
      const key = historyKey(m);
      const thinking = chatActivityHistory.has(key) ? chatActivityMarkup(chatActivityHistory.get(key), key, new Set(), m.text, { state: "completed", ...chatActivityTiming.get(key), overrides: chatDisclosureOverrides }) : thinkingMarkup(chatThinkingHistory.get(key), key, thinkingOpenKeys.has(key));
      return chatMessageMarkup({ role: "assistant", text: m.text, time: when, meta: m.meta ?? undefined }, index, thinking);
    })
    .join("");
  // The phase keeps the sheen continuous while run updates re-render the list.
  const typingIndicator = isGenerating
    ? uiText(`<div class="msg msg-ai msg-typing" role="status" aria-label="AI가 답변을 작성하고 있습니다" style="--typing-phase:-${Date.now() % 1800}ms"><span class="typing-label">답변 작성 중</span></div>`)
    : "";
  const errorMessage = auxiliaryActionError?.kind === "chat" && lastChatRequest?.key === `${view?.document.id}:${scopeKind}` ? auxiliaryActionError.message : auxiliaryRun?.taskKind === "chat" && auxiliaryRun.documentNodeId === view?.document.id && runChatScope(auxiliaryRun) === scopeKind && auxiliaryRun.state === "failed" ? auxiliaryRun.error?.message ?? t("응답을 받지 못했습니다.") : null;
  const chatError = !isGenerating && errorMessage
    ? `<div class="chat-error" role="alert">${esc(errorMessage)}<br><button class="btn btn-sm" type="button" data-chat-action="retry">${esc(t("다시 시도"))}</button></div>` : "";
  list.innerHTML = rendered || typingIndicator || currentThinking || chatError
    ? `${rendered}${currentThinking}${typingIndicator}${chatError}`
    : `<p class="muted chat-empty">${projectScope
      ? t("프로젝트 전체 채팅 기록이 없습니다. 요청 본문에는 문서 원문 없이 프로젝트 개요와 공통 문맥만 포함합니다.")
      : t("현재 문서 채팅 기록이 없습니다. 문서 snapshot은 로컬 CLI로 전송되며 번역 데이터는 변경하지 않습니다.")}</p>`;
  chatSurface.afterRender();
  restoreChatScroll();
}

function renderTerms(): void {
  const source = view?.source.contentText ?? "";
  const entries = (knowledge?.glossary ?? []).filter(entry => source.includes(entry.sourceTerm));
  must("#ctxTerms").innerHTML = entries.length ? entries.map(entry => `<div class="li" style="display:grid;gap:5px"><span><b class="hanmun">${esc(entry.sourceTerm)}</b> → ${esc(entry.targetTerm)}</span><span class="tag ${entry.usageStatus === "preferred" ? "tag-ok" : "tag-plain"}">${USAGE_LABELS[entry.usageStatus]}</span>${entry.noteMd ? `<p class="muted" style="white-space:pre-wrap;margin:0">${esc(entry.noteMd)}</p>` : ""}</div>`).join("") : uiText('<p class="muted" style="font-size:12px">원문에 일치하는 등록 용어가 없습니다. 확인한 표현은 ‘용어 등록’에서 남길 수 있습니다.</p>');
  const unc = knowledge?.uncertainties.filter((u) => u.state === "open") ?? [];
  must("#ctxUnc").innerHTML = unc.length
    ? unc
        .map(
          (u) =>
            `<div class="li"><span><b>${esc(u.id.slice(0, 8))}</b> ${esc(u.statementMd)}</span><span class="tag tag-warn">${esc(u.category)}</span></div>`,
        )
        .join("")
    : uiText('<p class="muted" style="font-size:12px">열린 불확실성이 없습니다.</p>');
}

function versionTagClass(state: EditorView["source"]["state"]): string {
  if (state === "confirmed") return "tag-ok";
  if (state === "draft") return "tag-draft";
  return "tag-warn";
}

function translationReady(): boolean {
  return !!view?.source.contentText.trim();
}

function renderSegmentation(): void {
  if (!view) return;
  const ready = translationReady();
  const badge = must("#segmentationStateBadge");
  badge.className = `tag ${ready ? "tag-ok" : "tag-warn"}`;
  badge.textContent = ready ? ui`${view.anchors.length}개 앵커` : t("생성 전");
  must("#segmentationMessage").textContent = ready
    ? ui`표점 원문 ${view.punctuation ? `P${view.punctuation.versionNo}` : ""}에서 생성한 앵커입니다. 이 목록은 직접 수정하지 않습니다.`
    : t("표점 원문을 확정하면 이 단계에 번역 앵커가 생성됩니다.");
  must("#segmentationAnchorList").innerHTML = ready
    ? view.anchors.map((anchor) => `<article class="segmentation-row">
        <div class="segmentation-row-meta"><b>${esc(anchor.anchorKey)}</b><span>${esc(anchor.boundaryKind)}</span><span>${anchor.punctuationFrom}–${anchor.punctuationTo}</span></div>
        <blockquote class="hanmun">${esc(anchor.punctuatedQuote)}</blockquote>
      </article>`).join("")
    : uiText('<div class="structure-empty"><b>아직 분절이 없습니다</b><span>표점 원문을 저장하고 확정하세요.</span></div>');
}

function updateDraftActionDisabled(): void {
  if (!view) return;
  const sourceText = must<HTMLTextAreaElement>("#sourceDraftText").value;
  const sourceEditable = view.source.state !== "confirmed" || sourceEditingConfirmed;
  must<HTMLButtonElement>("#btnSaveSourceDraft").disabled = !sourceEditable || !sourceText.trim() || !sourceDirty;
  must<HTMLButtonElement>("#btnConfirmSource").disabled = !sourceEditable || !sourceText.trim() || (!sourceDirty && view.source.state !== "draft");
  const punctuationText = must<HTMLTextAreaElement>("#punctuationDraftText").value;
  const sourceConfirmed = view.source.state === "confirmed";
  const punctuation = view.punctuation;
  const needsCreation = !punctuation || punctuation.state === "superseded";
  const punctuationNeedsRefresh = punctuation?.state === "rejected";
  const confirmedLocked = punctuation?.state === "confirmed" && !punctuationEditingConfirmed;
  const previewing = !!previewedPunctuationSuggestion();
  must<HTMLButtonElement>("#btnCreatePunctuationDraft").disabled = !sourceConfirmed || !needsCreation || sourceDirty;
  must<HTMLButtonElement>("#btnSavePunctuationDraft").disabled = confirmedLocked || previewing || !sourceConfirmed || !punctuation || punctuation.state === "superseded" || !punctuationText.trim() || (!punctuationDirty && !punctuationNeedsRefresh);
  must<HTMLButtonElement>("#btnConfirmPunctuation").disabled = confirmedLocked || previewing || !sourceConfirmed || !punctuation || punctuation.state === "superseded" || !punctuationText.trim() || (!punctuationDirty && punctuation.state !== "draft");
  must<HTMLButtonElement>("#btnCreateTranslationDraft").disabled =
    !translationReady() || view.translation !== null;
  must<HTMLButtonElement>("#btnResetTranslationDraft").disabled =
    !translationReady() || !view.translation || view.translation.isCurrentDependencies;
  renderAuxiliaryRunControls();
}

configureReadingType();
configureSourceView();
const punctuationWorkspaceUi = configurePunctuationWorkspace();

function renderDraftWorkspaces(): void {
  renderSaveState();
  if (!view) return;
  const sourceText = must<HTMLTextAreaElement>("#sourceDraftText");
  const sourceLocked = view.source.state === "confirmed" && !sourceEditingConfirmed;
  sourceText.readOnly = sourceLocked;
  must("#btnEditSource").hidden = !sourceLocked;
  must("#btnCancelSourceEdit").hidden = !sourceEditingConfirmed;
  must("#btnSaveSourceDraft").hidden = sourceLocked;
  must("#btnConfirmSource").hidden = sourceLocked;
  if (!sourceDirty) sourceText.value = view.source.contentText;
  must("#sourceTextCount").textContent = ui`${fmt(codepointLength(sourceText.value))}자`;
  must("#sourceVersion").textContent = ui`원문 V${view.source.versionNo}`;
  const sourceBadge = must("#sourceStateBadge");
  sourceBadge.className = `tag ${versionTagClass(view.source.state)}`;
  sourceBadge.textContent = VERSION_STATE_LABELS[view.source.state];
  const sourceMessage = must("#sourceMessage");
  sourceMessage.className = `workflow-notice${sourceDirty ? " is-warn" : view.source.state === "confirmed" ? " is-ok" : ""}`;
  sourceMessage.textContent = sourceDirty
    ? t("저장하지 않은 원문 변경이 있습니다. 저장하면 덮어쓰지 않고 새 원문안으로 보존됩니다.")
    : view.source.state === "confirmed"
      ? sourceEditingConfirmed
        ? t("확정 원문을 수정 중입니다. 저장하면 새 원문안으로 보존됩니다.")
        : ""
      : t("원문안을 저장한 뒤 확정하세요.");
  sourceMessage.hidden = !sourceMessage.textContent;

  const punctuationText = must<HTMLTextAreaElement>("#punctuationDraftText");
  const punctuation = view.punctuation;
  const punctuationNeedsCreation = !punctuation || punctuation.state === "superseded";
  const punctuationEditable = !!punctuation && punctuation.state !== "superseded";
  const preview = previewedPunctuationSuggestion();
  const confirmedLocked = punctuation?.state === "confirmed" && !punctuationEditingConfirmed;
  punctuationText.readOnly = !!preview || !punctuationEditable || confirmedLocked;
  must("#btnEditPunctuation").hidden = !confirmedLocked;
  must("#btnCancelPunctuationEdit").hidden = !punctuationEditingConfirmed;
  must("#btnSavePunctuationDraft").hidden = confirmedLocked || !!preview;
  must("#btnConfirmPunctuation").hidden = confirmedLocked || !!preview;
  punctuationText.hidden = !preview && !punctuationEditable;
  punctuationText.setAttribute("aria-describedby", preview ? "punctuationProposalState punctuationProposalHelp punctuationTextCount" : "punctuationTextCount");
  if (preview || !punctuationDirty) {
    const text = preview ? preview.responseText : punctuationEditable ? punctuation.punctuatedText : "";
    if (punctuationText.value !== text) {
      punctuationText.value = text;
      punctuationText.setSelectionRange(0, 0);
      punctuationText.scrollTop = 0;
    }
  }
  if (!punctuationDirty) {
    must<HTMLSelectElement>("#punctuationMode").value = punctuationEditable
      ? punctuation.structureMode
      : "prose";
  }
  punctuationWorkspaceUi.update(view.source.contentText,
    !preview && !punctuationDirty && !sourceDirty && punctuationEditable ? punctuation : null);
  must("#punctuationTextCount").textContent = ui`${fmt(codepointLength(punctuationText.value))}자${preview ? t(" · AI 제안 · 읽기 전용") : ""}`;
  must("#punctuationVersion").textContent = punctuationEditable
    ? ui`표점 P${punctuation.versionNo}`
    : t("현재 원문 기준 표점 원문 미생성");
  const punctuationMessage = must("#punctuationMessage");
  const sourceConfirmed = view.source.state === "confirmed";
  punctuationMessage.className = `workflow-notice${!sourceConfirmed || punctuationDirty || (!preview && punctuationNeedsCreation) ? " is-warn" : ""}`;
  punctuationMessage.textContent = preview
    ? ""
    : !sourceConfirmed
    ? t("원문안을 먼저 확정하세요. 확정 전에는 표점 원문을 만들 수 없습니다.")
    : punctuationNeedsCreation
      ? punctuation
        ? t("원문이 바뀌었습니다. 현재 확정 원문으로 새 표점 작업안을 만든 뒤 편집하세요.")
        : t("확정 원문으로 표점 작업안을 만들거나 AI 표점 원문 제안을 생성하세요.")
    : punctuationDirty
      ? t("저장하지 않은 표점 원문 변경이 있습니다. 구조 범위가 표점 원문과 맞는지 확인하세요.")
      : punctuation?.state === "confirmed"
        ? ""
        : t("표점 원문과 구조 범위를 저장한 뒤 확정하세요.");
  punctuationMessage.hidden = !punctuationMessage.textContent;
  const createActions = must<HTMLElement>("#punctuationCreateActions");
  createActions.hidden = !!preview || !sourceConfirmed || !punctuationNeedsCreation;
  const createCopy = createActions.querySelector("span");
  if (createCopy) {
    createCopy.innerHTML = punctuation
      ? uiText("<b>원문이 바뀌어 새 표점 작업안이 필요합니다.</b> 현재 확정 원문을 복사해 다시 시작하거나 AI 제안을 검토하세요.")
      : uiText("<b>표점 원문을 아직 만들지 않았습니다.</b> 확정 원문을 복사해 직접 시작하거나 AI 제안을 먼저 검토할 수 있습니다.");
  }
  must<HTMLElement>("#punctuationDraftFields").hidden = !!preview;
  must<HTMLElement>("#punctuationDraftActions").hidden = !punctuationEditable || (!!preview && !confirmedLocked && !punctuationEditingConfirmed);
  renderEditingLocks();

  updateDraftActionDisabled();
}

function renderWorkflowProgress(): void {
  if (!view) return;
  const source = view.source;
  const punctuation = view.punctuation;
  const translation = view.translation;
  const ready = translationReady();
  const currentTranslation = translation?.isCurrentDependencies ? translation : null;
  const progress = [
    { id: "Source", done: source.state === "confirmed" && !sourceDirty,
      attention: sourceDirty || source.state === "rejected" },
    { id: "Punctuation", done: punctuation?.state === "confirmed" && !punctuationDirty && !sourceDirty,
      attention: punctuationDirty || punctuation?.state === "superseded" || punctuation?.state === "rejected" },
    { id: "Translation", done: currentTranslation?.state === "confirmed" && !dirty && !sourceDirty && !punctuationDirty,
      attention: dirty || (!!translation && !translation.isCurrentDependencies) || currentTranslation?.state === "rejected" },
  ];
  for (const step of progress) {
    const button = must<HTMLButtonElement>(`#step${step.id}`);
    button.classList.toggle("is-done", step.done);
    button.classList.toggle("is-attention", step.attention);
  }
  const completed = workspace === "translation" && currentTranslation?.state === "confirmed" && !dirty;
  must("#workflowGuideLabel").textContent = completed ? t("번역 확정됨") : t("다음 할 일");
  must("#workflowHint").textContent = workspace === "source"
    ? sourceDirty ? t("원문 변경을 저장하세요. 다른 단계로 이동할 때도 먼저 저장합니다.")
      : !ready ? t("원문을 입력하고 저장하세요. 표점 없이 바로 번역할 수 있습니다.")
      : source.state === "confirmed" ? t("원문이 준비되었습니다. 바로 번역하거나, 필요하면 표점을 먼저 정리하세요.")
      : t("원문을 대조하고 확정하세요. 저장된 원문만으로 번역을 시작할 수도 있습니다.")
    : workspace === "punctuation"
      ? punctuationDirty ? t("표점 변경을 저장한 뒤 확정하세요. 표점은 선택 작업입니다.")
        : previewedPunctuationSuggestion() ? t("AI 제안을 원문과 대조하고 적용하세요. 표점 없이 번역할 수도 있습니다.")
        : punctuation?.state === "confirmed" ? t("표점이 확정되었습니다. 번역 단계에서 문장별로 대조하세요.")
        : t("필요한 구두점과 문단을 정리하세요. 표점은 생략하고 번역할 수 있습니다.")
      : workspace === "terms" ? "필요한 용어만 검토하세요. 검토한 풀이를 번역에 반영하며, 이 단계는 건너뛸 수 있습니다."
      : !ready ? t("원문 단계에서 번역할 내용을 먼저 입력하고 저장하세요.")
        : translation && !currentTranslation ? t("원문 또는 표점 기준이 변경되었습니다. 현재 기준으로 새 번역안을 만드세요.")
        : !currentTranslation ? t("직접 번역을 입력하거나 AI 번역을 시작하세요. 표점은 선택 사항입니다.")
        : completed ? t("내용이 승인된 번역입니다. 수정하려면 ‘새 번역안으로 수정’을 누르세요.")
        : validate(shownBlocks()).length ? t("저장 검사에서 발견된 문제를 먼저 수정한 뒤 번역안을 확정하세요.")
        : t("문장별 대조로 원문 대응과 번역 내용을 검토한 뒤, 상단의 ‘확정’을 누르세요.");
  const next = must<HTMLButtonElement>("#btnWorkflowTranslation");
  next.hidden = workspace === "translation" || !ready;
  next.disabled = editorMutationBusy() || workspaceSwitching;
  next.firstChild!.textContent = workspace === "punctuation" && punctuation?.state !== "confirmed" ? t("표점 없이 번역 ") : t("번역으로 ");
}

function renderWorkflow(): void {
  if (!view) return;
  const ready = translationReady();
  const currentTranslation = view.translation?.isCurrentDependencies ? view.translation : null;
  const staleTranslation = view.translation && !view.translation.isCurrentDependencies ? view.translation : null;
  const hasTranslation = currentTranslation !== null;
  renderWorkflowProgress();
  must("#segmentationStepState").textContent = ready
    ? ui`앵커 ${view.anchors.length}개`
    : t("표점 확정 필요");
  const punctuationStep = must<HTMLButtonElement>("#stepPunctuation");
  const segmentationStep = must<HTMLButtonElement>("#stepSegmentation");
  const translationStep = must<HTMLButtonElement>("#stepTranslation");
  punctuationStep.disabled = view.source.state !== "confirmed";
  segmentationStep.disabled = !ready;
  translationStep.disabled = !ready;
  must<HTMLButtonElement>("#stepTerms").disabled = !ready;
  punctuationStep.setAttribute("aria-disabled", String(punctuationStep.disabled));
  segmentationStep.setAttribute("aria-disabled", String(segmentationStep.disabled));
  translationStep.setAttribute("aria-disabled", String(translationStep.disabled));
  $$("#workflow [data-workspace]").forEach((button) => {
    const selected = button.dataset.workspace === workspace;
    button.classList.toggle("is-on", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    const current = button.querySelector<HTMLElement>(".workflow-current");
    if (current) current.hidden = !selected;
  });
  $$(".workspace-panel").forEach((panel) => {
    const selected = panel.id === `${workspace}Workspace`;
    panel.classList.toggle("is-open", selected);
    (panel as HTMLElement).hidden = !selected;
  });
  const segmentation = workspace === "segmentation";
  const translation = workspace === "translation";
  must<HTMLElement>("#translationEmpty").hidden = hasTranslation || !!staleTranslation;
  must<HTMLElement>("#translationCurrent").hidden = !hasTranslation;
  must<HTMLElement>("#translationStale").hidden = !staleTranslation;
  must<HTMLElement>("#manualDraftControls").hidden = !!view.translation;
  must<HTMLButtonElement>("#btnResetTranslationDraft").hidden = !staleTranslation;
  // Saved source supports source reading and study before a translation exists.
  // Keep view navigation available so those views always have an exit.
  must<HTMLElement>("#translationToolbar").hidden = !translation || !ready;
  must<HTMLElement>("#stateBadge").hidden = !hasTranslation;
  must<HTMLElement>("#validBadge").hidden = !hasTranslation;
  must<HTMLButtonElement>("#btnPrepare").hidden = !translation;
  must<HTMLButtonElement>("#btnDiff").hidden = false;
  if (translation && hasTranslation) {
    renderStrip();
  } else if (translation) {
    must<HTMLElement>("#vstrip").hidden = true;
    must<HTMLButtonElement>("#btnConfirm").hidden = true;
    must<HTMLButtonElement>("#btnRevise").hidden = true;
  } else {
    must<HTMLButtonElement>("#btnConfirm").hidden = true;
    must<HTMLButtonElement>("#btnRevise").hidden = true;
  }
  const docTitle = view.document.originalTitle || view.document.title;
  must("#titleSub").textContent = `— ${{ source: t("원문안"), punctuation: t("표점 원문"), segmentation: t("분절"), terms: "용어", translation: t("번역안") }[workspace]}`;
  must("#sbValid").textContent = workspace === "source"
    ? ui`원문 ${VERSION_STATE_LABELS[view.source.state]}`
    : workspace === "punctuation"
      ? view.punctuation ? ui`표점 ${VERSION_STATE_LABELS[view.punctuation.state]}` : t("표점 미생성")
      : view.translation?.textLayout ? ui`번역 ${view.translation.textLayout.sentences.length}문장` : ui`${view.anchors.length}개 앵커`;
  document.title = ui`${docTitle} — 문해 Munhae Studio`;
}

function setWorkspace(next: Workspace, committedMutation = false): void {
  if (next !== workspace && readingStudy.hasUnsavedDraft()) {
    void readingStudy.save().then(saved => { if (saved) setWorkspace(next, committedMutation); });
    return;
  }
  if (!committedMutation && next !== workspace && (editorMutationBusy() || workspaceSwitching)) return;
  if (next !== workspace && (sourceDirty || punctuationDirty || dirty)) {
    void saveBeforeWorkspaceSwitch(next);
    return;
  }
  if (next !== "translation") reviewComments.cancelSelection();
  if (!view) return;
  if (next === "punctuation" && view.source.state !== "confirmed") {
    notify(t("원문안을 먼저 확정하세요"), t("표점 원문"));
    return;
  }
  if (next === "segmentation" && !translationReady()) {
    notify(t("표점 원문을 확정해 분절 앵커를 먼저 만드세요"), t("분절"));
    return;
  }
  if (next === "translation" && !translationReady()) {
    notify(t("원문을 먼저 저장하세요"), t("번역"));
    return;
  }
  $$(".editor-tool-popover:popover-open").forEach((popover) => popover.hidePopover());
  workspace = next;
  syncSentenceSelection();
  if (next === "terms") void termReview.load(true);
  editorAids.rememberPosition();
  must("#ws").classList.toggle("reading-layout", next === "translation" && layout === "reading");
  syncReadingDrawer();
  readingStudy.setVisible(next === "translation" && layout === "reading");
  renderWorkflow();
  if (next === "source") must<HTMLTextAreaElement>("#sourceDraftText").focus();
  if (next === "punctuation") {
    const punctuation = view.punctuation;
    if (!previewedPunctuationSuggestion() && (!punctuation || punctuation.state === "superseded")) {
      must<HTMLButtonElement>("#btnCreatePunctuationDraft").focus();
    } else {
      must<HTMLTextAreaElement>("#punctuationDraftText").focus();
    }
  }
}

async function saveBeforeWorkspaceSwitch(next: Workspace): Promise<void> {
  if (workspaceSwitching || editorMutationBusy()) return;
  workspaceSwitching = true;
  try {
    // A workspace is left only after its draft is durable. A failed save keeps
    // the user in the same editor with their exact input and retry controls.
    const saved = sourceDirty ? await saveSourceDraft()
      : punctuationDirty ? await savePunctuationDraft()
      : dirty ? !!(await saveDraft()) : true;
    workspaceSwitching = false;
    if (saved) setWorkspace(next);
  } finally {
    workspaceSwitching = false;
    renderSaveState();
  }
}

function renderSaveState(): void {
  must("#editorSaveState").textContent = editorMutationBusy() ? t("저장 중…")
    : hasUnsavedChanges() ? t("저장하지 않은 변경") : savedLocallyLabel();
  renderWorkflowProgress();
}

function renderFolioDocument(): void {
  if (!view) return;
  const d = view.document;
  must("#titleDoc").textContent = d.originalTitle || d.title;
  const projection = view.punctuation?.state === "confirmed"
    ? createPunctuationProjection(view.source.contentText, view.punctuation.punctuatedText) : null;
  const punctuation = projection ? view.punctuation : null;
  must("#folioSourceLabel").textContent = punctuation ? t("확정 표점 원문") : t("원문");
  const source = punctuation?.punctuatedText ?? view.source.contentText;
  const sourceElement = must("#folioSourceText");
  sourceElement.textContent = source;
  sourceElement.dataset.reviewSourceFrom = "0";
  sourceElement.dataset.reviewSourceTo = String(sourceCodepoints.length);
  sourceElement.dataset.reviewSourceQuote = view.source.contentText;
  if (projection) sourceElement.dataset.reviewSourceMap = JSON.stringify(projection.sourceBoundaryByPunctuationBoundary);
  else delete sourceElement.dataset.reviewSourceMap;
  must("#translationWorkspace").classList.toggle("full-text-document", !!view.translation?.textLayout);
  const aiButton = must("#btnPrepare");
  const actions = must("#translationWorkspace > .segmentation-actions");
  (view.translation?.isCurrentDependencies ? must("#translationCommandActions") : actions).append(aiButton);
  aiButton.classList.toggle("is-secondary-translation", !!view.translation?.isCurrentDependencies);
  actions.classList.toggle("has-translation", !!view.translation?.isCurrentDependencies);
  renderTranslationRunIndicator();
  renderSaveState();
}

function renderDocMeta(): void {
  if (!view) return;
  const d = view.document;
  must("#docMeta").innerHTML = ui`<dt>저자</dt><dd>${esc(d.authorName ?? "—")}</dd>
    <dt>시기</dt><dd>${esc(d.periodText ?? "—")}</dd>
    <dt>날짜</dt><dd>${esc(d.dateText ?? "—")}</dd>
    <dt>언어</dt><dd>${esc(d.language ?? "—")}</dd>
    <dt>서지</dt><dd>${esc(d.sourceReference ?? "—")}</dd>`;
  must("#anchorCount").textContent = String(view.anchors.length);
  must("#sbPath").textContent = `${projectLocationLabel(view.project)} › ${d.originalTitle || d.title}`;
  must("#sbVersions").textContent = ui`원문 V${view.source.versionNo} · ${view.punctuation ? ui`표점 P${view.punctuation.versionNo}` : t("표점 미생성")} · 앵커 ${view.anchors.length}`;
}

function clearReferencePreview(): void {
  referenceLoadSerial += 1;
  if (referenceObjectUrl) URL.revokeObjectURL(referenceObjectUrl);
  referenceObjectUrl = null;
  loadedReferenceKey = null;
  const image = must<HTMLImageElement>("#referenceImage");
  const pdf = must<HTMLIFrameElement>("#referencePdf");
  image.hidden = true;
  image.removeAttribute("src");
  pdf.hidden = true;
  pdf.removeAttribute("src");
}

function referenceStateText(state: EditorView["referenceAssets"][number]["state"]): string {
  if (state === "missing") return t("패키지 안에서 파일을 찾을 수 없습니다.");
  if (state === "unsafe_path") return t("안전하지 않은 파일 경로여서 표시하지 않았습니다.");
  if (state === "size_mismatch") return t("저장된 크기와 파일 크기가 다릅니다.");
  if (state === "hash_mismatch") return t("SHA-256 검증에 실패해 파일을 표시하지 않았습니다.");
  return "";
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

async function loadReferencePreview(asset: EditorView["referenceAssets"][number]): Promise<void> {
  if (!view || asset.state !== "present") return;
  const documentNodeId = view.document.id;
  const key = `${documentNodeId}:${asset.id}:${asset.sha256}`;
  if (loadedReferenceKey === key) return;
  clearReferencePreview();
  loadedReferenceKey = key;
  const serial = referenceLoadSerial;
  const unavailable = must<HTMLElement>("#referenceUnavailable");
  unavailable.hidden = false;
  unavailable.textContent = t("참고 자료를 확인하는 중…");
  const result = await api.editor.readReference(documentNodeId, asset.id);
  if (serial !== referenceLoadSerial || view?.document.id !== documentNodeId || activeReferenceId !== asset.id) return;
  if (!result.ok) {
    loadedReferenceKey = null;
    unavailable.textContent = result.error.message;
    return;
  }
  const blob = new Blob([decodeBase64(result.data.base64)], { type: result.data.mimeType });
  referenceObjectUrl = URL.createObjectURL(blob);
  unavailable.hidden = true;
  const image = must<HTMLImageElement>("#referenceImage");
  const pdf = must<HTMLIFrameElement>("#referencePdf");
  if (asset.assetKind === "pdf") {
    pdf.src = referenceObjectUrl;
    pdf.hidden = false;
  } else {
    image.src = referenceObjectUrl;
    image.alt = ui`${asset.originalFilename} 참고 이미지`;
    image.hidden = false;
  }
}

function renderReferencePanel(): void {
  if (!view) return;
  const assets = view.referenceAssets;
  const empty = must<HTMLElement>("#referenceEmpty");
  const browser = must<HTMLElement>("#referenceBrowser");
  empty.hidden = assets.length > 0;
  browser.hidden = assets.length === 0;
  if (!assets.length) {
    activeReferenceId = null;
    clearReferencePreview();
    return;
  }
  if (!activeReferenceId || !assets.some((asset) => asset.id === activeReferenceId)) {
    activeReferenceId = assets[0]!.id;
    clearReferencePreview();
  }
  const select = must<HTMLSelectElement>("#referenceSelect");
  select.innerHTML = assets.map((asset) =>
    `<option value="${esc(asset.id)}"${asset.id === activeReferenceId ? " selected" : ""}>${esc(asset.originalFilename)}</option>`,
  ).join("");
  const asset = assets.find((item) => item.id === activeReferenceId) ?? assets[0]!;
  must("#referenceName").textContent = asset.originalFilename;
  const pages = asset.pageCount ? ui` · ${asset.pageCount}쪽` : "";
  must("#referenceMeta").textContent = `${asset.assetKind === "pdf" ? "PDF" : t("이미지")}${pages} · ${(asset.byteSize / 1024 / 1024).toFixed(1)}MB · ${asset.sha256.slice(0, 12)}…`;
  const unavailable = must<HTMLElement>("#referenceUnavailable");
  const openButton = must<HTMLButtonElement>("#btnOpenReference");
  openButton.disabled = asset.state !== "present";
  if (asset.state !== "present") {
    clearReferencePreview();
    unavailable.hidden = false;
    unavailable.textContent = referenceStateText(asset.state);
    return;
  }
  void loadReferencePreview(asset);
}

function renderAll(): void {
  renderSource();
  renderRows();
  renderFull();
  renderStrip();
  renderHistory();
  renderChat();
  renderAuxiliaryRunControls();
  renderTerms();
  renderDocMeta();
  renderFolioDocument();
  renderReferencePanel();
  renderDraftWorkspaces();
  renderSegmentation();
  renderWorkflow();
}

function setHot(keys: string[]): void {
  hot = keys;
  const bs = shownBlocks();
  const has = (b: Block | undefined): boolean => !!b && b.anchors.some((k) => keys.includes(k));
  $$("#sourceText .anchor").forEach((a) => a.classList.toggle("is-hot", keys.includes(a.dataset.key ?? "")));
  $$("#rows .akey").forEach((k) => k.classList.toggle("is-hot", keys.includes(k.dataset.akey ?? "")));
  $$("#rows .brow").forEach((r) => r.classList.toggle("is-hot", has(bs.find((x) => x.key === r.dataset.key))));
  $$("#fullText .blk").forEach((s) => s.classList.toggle("is-hot", has(bs.find((x) => x.key === s.dataset.key))));
}

function setView(v: Layout): void {
  if (v !== layout && readingStudy.isBusy()) return;
  if (v !== "reading" && layout === "reading" && readingStudy.hasUnsavedDraft()) {
    void readingStudy.save().then(saved => { if (saved) setView(v); });
    return;
  }
  if (v === "reading" && (sourceDirty || punctuationDirty || dirty)) {
    void (sourceDirty ? saveSourceDraft() : punctuationDirty ? savePunctuationDraft() : saveDraft()).then(saved => { if (saved) setView(v); });
    return;
  }
  if (v !== "parallel") reviewComments.cancelSelection();
  editorAids.rememberPosition();
  const enteringReading = v === "reading" && layout !== "reading";
  layout = v;
  must("#ws").classList.toggle("reading-layout", workspace === "translation" && v === "reading");
  $$("#viewSeg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  $$(".view").forEach((el) => el.classList.toggle("is-open", el.id === `view${v[0]?.toUpperCase()}${v.slice(1)}`));
  if (v === "parallel" || v === "full") resizeSentenceEditors();
  if (v === "full" && selectedSentenceId) highlightBookSource(selectedSentenceId);
  renderComparisonState();
  syncReadingDrawer();
  readingStudy.setVisible(workspace === "translation" && v === "reading", v === "reading" ? selectedSentenceId : null);
  if (enteringReading) must("#viewReading").closest(".pane-scroll")?.scrollTo({ top: 0 });
}

function syncReadingDrawer(): void {
  const reading = workspace === "translation" && layout === "reading";
  const tab = must("#contextTab");
  const entering = reading && tab.dataset.tab !== "reading";
  const leavingSelected = !reading && tab.dataset.tab === "reading" && tab.getAttribute("aria-selected") === "true";
  tab.dataset.tab = reading ? "reading" : "context";
  tab.dataset.i18n = reading ? "뜻풀이" : "참고 자료";
  tab.textContent = t(tab.dataset.i18n);
  tab.setAttribute("aria-controls", reading ? "rp-reading" : "rp-context");
  if (entering) setTab("reading");
  else if (leavingSelected) setTab("context");
}

function setTab(t: string): void {
  const reading = workspace === "translation" && layout === "reading";
  if (t === "context" && reading) t = "reading";
  else if (t === "reading" && !reading) t = "context";
  $$("#rtabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  $$(".rpanel").forEach((p) => p.classList.toggle("is-open", p.id === `rp-${t}`));
  if ($("#ws")?.classList.contains("no-ctx")) togglePane("ctx", false);
}

function selectRow(key: string): void {
  active = key;
  $$("#rows .brow").forEach((x) => x.classList.toggle("is-active", x.dataset.key === key));
}

function togglePane(which: "ref" | "ctx", force?: boolean): void {
  if (layout === "reading" && which === "ref") {
    if (readingStudy.isBusy() || readingStudy.hasUnsavedDraft()) { notify(t("풀이를 저장한 뒤 다른 패널을 여세요."), t("구절 연구")); return; }
    setView("parallel");
  }
  const ws = must("#ws");
  const cls = which === "ref" ? "no-ref" : "no-ctx";
  const hide = force !== undefined ? force : !ws.classList.contains(cls);
  ws.classList.toggle(cls, hide);
  store.set(`munhae.${which}`, hide ? "0" : "1");
  $(which === "ref" ? "#tbRef" : "#tbCtx")?.classList.toggle("is-on", !hide);
}

function applyView(v: EditorView, options: { saved?: boolean; preserveHistory?: boolean } = {}): void {
  editorViewSerial += 1;
  editorAids.beforeView();
  const documentChanged = view?.document.id !== v.document.id;
  if (documentChanged) {
    punctuationProgressMode = false;
    must<HTMLDialogElement>("#dlgPunctuation").close();
    selectedSentenceId = null;
    must<HTMLInputElement>("#alignmentReviewOnly").checked = false;
    must<HTMLInputElement>("#comparisonQuery").value = "";
    must<HTMLSelectElement>("#comparisonFilter").value = "all";
    documentFind.reset();
    chatLoadSerial += 1;
    prepRequest += 1;
    prepPreview = null;
    prepDocId = null;
    prepRevision = undefined;
    prepAuxMode.clear();
    punctuationSuggestion = null;
    activeReferenceId = v.referenceAssets[0]?.id ?? null;
    clearReferencePreview();
  }
  view = v;
  sourceCodepoints = Array.from(v.source.contentText);
  punctuationProjection = v.punctuation && ["draft", "confirmed"].includes(v.punctuation.state)
    && (!v.translation?.textLayout || v.translation.isCurrentDependencies)
    ? createPunctuationProjection(v.source.contentText, v.punctuation.punctuatedText) : null;
  blocks = v.translation ? blocksFrom(v.translation) : [];
  dirty = false;
  pendingTranslationEdits.clear();
  sourceDirty = false;
  sourceEditingConfirmed = false;
  punctuationDirty = false;
  punctuationEditingConfirmed = false;
  punctuationPreviewing = false;
  punctuationDraftBeforePreview = null;
  structureDrafts = (v.punctuation?.structureSpans ?? [])
    .filter((span): span is typeof span & { spanKind: StructureSpanKind } => span.spanKind in STRUCTURE_KIND_LABELS)
    .map((span) => ({
      spanKey: span.id,
      spanKind: span.spanKind,
      parentSpanKey: span.parentSpanId,
      ordinal: span.ordinal,
      codepointFrom: span.codepointFrom,
      codepointTo: span.codepointTo,
      label: span.label,
    }));
  if (documentChanged) selectedGapId = null;
  if (documentChanged) workspace = v.source.contentText.trim() ? "translation" : "source";
  if (workspace === "terms") void termReview.load();
  if (workspace === "segmentation") workspace = "translation";
  if (v.translation?.textLayout) {
    editingSentenceId = null;
    groupStructureDirty = false;
    must("#bookGroups").replaceChildren();
    sentenceDrafts = groupedTextSentences(v.translation.textContent, v.translation.textLayout.sentences, v.translation.textLayout.links);
    savedGroupTexts = new Map(sentenceDrafts.map(sentence => [sentence.id, sentence.text]));
    sentenceLinks = v.translation.textLayout.links.filter(link => sentenceDrafts.some(sentence => sentence.id === link.sentenceId)).map((link) => ({ ...link }));
    if (v.project.storageMode === "local") sentenceLinks = sentenceDrafts.map(sentence => {
      const link = sentenceLinks.find(l => l.sentenceId === sentence.id);
      return { sentenceId: sentence.id, groupId: link?.groupId ?? sentence.id, spans: link?.spans ?? [], needsReview: link?.needsReview ?? true, ...(link?.reviewedBy ? { reviewedBy: link.reviewedBy } : {}) };
    });
    translationDraftText = v.translation.textContent;
    must<HTMLTextAreaElement>("#fullTranslationInput").value = translationDraftText;
    if (documentChanged) layout = "parallel";
  } else { sentenceDrafts = []; sentenceLinks = []; translationDraftText = ""; savedGroupTexts = new Map(); }

  active = null;
  editorAids.loaded(options);
  renderAll();
  readingStudy.setDocument(v);
  setView(layout);
  editorAids.finishView();
  void reviewComments.load();
  documentMaterials.setDocument(v);
  void loadVersionHistory(v.document.id, historyKind(), historyKind() === "translation" ? "translation" : null);
  setSelfTitle(`${v.document.originalTitle || v.document.title} — ${v.project.title}`);
}

function payloadBlocks(): SaveBlocks {
  return blocks.map((b) => ({
    blockKey: b.key,
    blockKind: b.kind || "paragraph",
    translation: b.text,
    sourceAnchorIds: b.anchors,
    relationKinds: b.relationKinds,
  }));
}

type SaveBlocks = Array<{
  blockKey: string;
  blockKind: string;
  translation: string;
  sourceAnchorIds: string[];
  relationKinds: string[];
}>;

async function saveDraft(title = t("저장")): Promise<EditorView | null> {
  if (!view || !editing()) return view;
  if (editorMutationBusy()) return null;
  const lockVersion = translationLockVersion();
  if (lockVersion === undefined) {
    notify(t("편집 중인 번역안의 잠금 버전을 찾을 수 없습니다"), title);
    return null;
  }
  translationSaving = true;
  renderFull();
  const documentNodeId = view.document.id;
  try {
    const result = await api.editor.saveDraft({
      documentNodeId: view.document.id,
      textContent: view.translation?.textLayout ? translationDraftText : joinBlocks(blocks),
      ...(view.project.storageMode === "local" && view.translation?.textLayout?.storageRevision ? { textBaseVersionId: view.translation.versionId, textBaseRevision: view.translation.textLayout.storageRevision } : {}),
      ...(view.translation?.textLayout && (view.project.storageMode === "local" || sentenceLinks.some(link => link.groupId)) ? { textGroups: sentenceDrafts.map(sentence => ({
        id: sentenceLinks.find(link => link.sentenceId === sentence.id)?.groupId ?? sentence.id,
        from: sentence.from, to: sentence.to, text: sentence.text, spans: sentenceLinks.find(link => link.sentenceId === sentence.id)?.spans ?? [],
      })) } : {}),
      blocks: payloadBlocks(),
      expectedLockVersion: lockVersion,
    });
    const data = unwrap(result, title);
    if (data && view?.document.id === documentNodeId) {
      dirty = false;
      must("#sbSaved").textContent = nowHM();
      applyView(data, { saved: true, preserveHistory: true });
      return data;
    }
    return null;
  } catch (error) {
    notify(error instanceof Error ? error.message : t("번역안을 저장하지 못했습니다"), title);
    return null;
  } finally {
    translationSaving = false;
    renderFull();
  }
}

function focusBlockOrderControl(blockKey: string, preferredDirection: "up" | "down"): void {
  const row = $$<HTMLElement>("#rows .brow").find((item) => item.dataset.key === blockKey);
  if (!row) return;
  const preferred = row.querySelector<HTMLButtonElement>(`button[data-move="${preferredDirection}"]`);
  const fallback = row.querySelector<HTMLButtonElement>("button[data-move]:not(:disabled)");
  (preferred && !preferred.disabled ? preferred : fallback)?.focus();
}

async function moveBlock(i: number, direction: "up" | "down"): Promise<void> {
  if (blockOrderSaving) return;
  if (!editing()) {
    notify(t("확정본은 읽기 전용입니다. 새 번역안으로 수정한 뒤 순서를 바꾸세요"), t("블록 순서"));
    return;
  }
  const target = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || target < 0 || target >= blocks.length) {
    notify(direction === "up" ? t("첫 블록은 더 위로 옮길 수 없습니다") : t("마지막 블록은 더 아래로 옮길 수 없습니다"), t("블록 순서"));
    return;
  }

  collectEdits();
  const previous = [...blocks];
  const wasDirty = dirty;
  const moving = blocks[i];
  const displaced = blocks[target];
  if (!moving || !displaced) return;
  blocks[i] = displaced;
  blocks[target] = moving;
  active = moving.key;
  dirty = true;
  blockOrderSaving = true;
  renderRows();
  renderFull();
  renderStrip();

  let saved: EditorView | null = null;
  try {
    saved = await saveDraft(t("블록 순서"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("블록 순서를 저장하지 못했습니다"), t("블록 순서"));
  } finally {
    blockOrderSaving = false;
  }
  if (!saved) {
    blocks = previous;
    dirty = wasDirty;
    renderRows();
    renderFull();
    renderStrip();
    focusBlockOrderControl(moving.key, direction);
    return;
  }

  renderRows();
  focusBlockOrderControl(moving.key, direction);
  notify(ui`${moving.key} 블록을 ${direction === "up" ? t("위") : t("아래")}로 옮겨 새 번역안에 저장했습니다`, t("블록 순서"));
}

async function saveIfDirty(): Promise<boolean> {
  if (!dirty) return true;
  return (await saveDraft()) !== null;
}

function collectTranslationEdit(el: HTMLElement): boolean {
  if (!editing()) return false;
  const key = el.dataset.edit;
  const block = blocks.find((item) => item.key === key);
  if (!key || !block) return false;
  const text = el.textContent?.trim() ?? "";
  if (text === block.text) return false;
  block.text = text;
  dirty = true;
  pendingTranslationEdits.add(key);
  editorAids.record(`block:${key}`);
  return true;
}

function collectEdits(): void {
  if (!editing()) return;
  if(view?.translation?.textLayout) return;
  $$("#rows .tgt-edit").forEach((el) => collectTranslationEdit(el));
}

function openCtx(i: number, x: number, y: number): void {
  cmIdx = i;
  const can = editing();
  const bs = shownBlocks();
  const cm = must("#ctxmenu");
  cm.innerHTML = ui`<button data-cm="merge" type="button"${!can || i === bs.length - 1 ? " disabled" : ""}>다음 블록과 합치기<kbd>⌥⌘M</kbd></button><button data-cm="split" type="button"${can ? "" : " disabled"}>나누기…<kbd>⌥⌘S</kbd></button><button data-cm="link" type="button"${can ? "" : " disabled"}>앵커 연결…<kbd>⌥⌘L</kbd></button><hr><button data-cm="source" type="button">표점 전문에서 보기</button><button data-cm="diff" type="button">변경 비교<kbd>⌘D</kbd></button>${can ? "" : uiText("<hr><button type='button' disabled>확정본은 새 번역안으로 수정해야 합니다</button>")}`;
  cm.classList.add("show");
  const w = cm.offsetWidth;
  const h = cm.offsetHeight;
  cm.style.left = `${Math.max(8, Math.min(x, innerWidth - w - 8))}px`;
  cm.style.top = `${Math.min(y, innerHeight - h - 8)}px`;
}

async function mergeAt(i: number): Promise<void> {
  if (!view || editorMutationBusy()) return;
  collectEdits();
  if (!(await saveIfDirty())) return;
  const bs = blocks;
  const left = bs[i];
  const right = bs[i + 1];
  if (!left || !right) return;
  const lockVersion = translationLockVersion();
  if (lockVersion === undefined) return;
  const documentNodeId = view.document.id;
  const data = await runEditorViewAction("#btnSaveFullTranslation", t("합치기"), () => api.editor.mergeBlocks({
    documentNodeId,
    leftBlockKey: left.key,
    rightBlockKey: right.key,
    expectedLockVersion: lockVersion,
  }));
  if (data) {
    applyView(data);
    notify(t("블록을 합쳤습니다"), t("블록"));
  }
}

function openSplit(i: number): void {
  splitIdx = i;
  const b = blocks[i];
  if (!b) return;
  must<HTMLTextAreaElement>("#splitText").value = b.text;
  must("#splitAnchors").innerHTML = b.anchors.length > 1
    ? b.anchors
        .slice(0, -1)
        .map(
          (k, j) =>
            ui`<label><input type="radio" name="sa" value="${j + 1}" ${j === 0 ? "checked" : ""}> 앞 블록: ${esc(b.anchors.slice(0, j + 1).join(", "))} <span class="muted">/ 뒤 블록: ${esc(b.anchors.slice(j + 1).join(", "))}</span></label>`,
        )
        .join("")
    : uiText('<p class="muted">단일 앵커는 두 블록에 부분 대응(partial)으로 연결됩니다.</p>');
  (must("#dlgSplit") as HTMLDialogElement).showModal();
}

function openLink(i: number): void {
  linkIdx = i;
  const b = blocks[i];
  if (!b || !view) return;
  must("#linkAnchors").innerHTML = view.anchors
    .map(
      (a) =>
        `<label><input type="checkbox" name="la" value="${esc(a.anchorKey)}" ${b.anchors.includes(a.anchorKey) ? "checked" : ""}> <span class="mono">${esc(a.anchorKey)}</span> <span class="hanmun" style="font-size:14px">${esc(quoteFor(a.anchorKey))}</span></label>`,
    )
    .join("");
  (must("#dlgLink") as HTMLDialogElement).showModal();
}

function openDiff(): void {
  openVersionDiff(historyKind(), workspace === "translation" ? "translation" : null);
}

function openConfirm(): void {
  if (!view) return;
  if (!view.punctuation && !view.translation?.textLayout) {
    notify(t("확정된 표점 원문과 분절이 필요합니다"), t("번역안 확정"));
    return;
  }
  const translation = view.translation;
  if (!translation?.isCurrentDependencies) {
    notify(t("현재 원문을 기준으로 한 번역 작업안이 필요합니다"), t("번역안 확정"));
    return;
  }
  must("#confirmText").textContent = ui`번역안 v${translation.versionNo}을 확정합니다. 확정은 내용 승인이며 공유와는 별개입니다.`;
  must("#confirmKv").innerHTML = ui`<dt>참조</dt><dd class="mono">원문 V${view.source.versionNo}${view.punctuation ? ui` · 표점 P${view.punctuation.versionNo}` : ""}</dd><dt>저장 검사</dt><dd>${validate(blocks).length ? "needs_review" : "valid"}</dd><dt>원문 대응</dt><dd>사용자 검토 대상</dd><dt>공유</dt><dd class="muted">확정과 별개 — 이 로컬 프로젝트는 공유하지 않습니다</dd>`;
  const checks = translationChecks.summary();
  must("#confirmKv").insertAdjacentHTML("beforeend", ui`<dt>내용 점검</dt><dd>${checks.length}개 확인 항목 · 번역 점검에서 위치를 볼 수 있습니다.</dd>`);
  (must("#dlgConfirm") as HTMLDialogElement).showModal();
}

function setActionBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string): void {
  if (busy) {
    activeMutations.set(button, view?.document.id ?? "");
    button.dataset.idleLabel = button.textContent ?? "";
    button.textContent = busyLabel;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    renderEditingLocks();
    renderSaveState();
    return;
  }
  activeMutations.delete(button);
  button.textContent = button.dataset.idleLabel ?? button.textContent;
  delete button.dataset.idleLabel;
  button.removeAttribute("aria-busy");
  button.disabled = false;
  updateDraftActionDisabled();
  renderEditingLocks();
  renderComparisonState();
  renderSaveState();
}

function actionResultIsCurrent(button: HTMLButtonElement): boolean {
  return view?.document.id === activeMutations.get(button);
}

async function runEditorViewAction(
  buttonSelector: string,
  title: string,
  request: () => ReturnType<typeof api.editor.get>,
): Promise<EditorView | null> {
  if (!view || editorMutationBusy()) return null;
  const button = must<HTMLButtonElement>(buttonSelector);
  setActionBusy(button, true, t("처리 중…"));
  try {
    const result = await request();
    if (!actionResultIsCurrent(button)) return null;
    return unwrap(result, title);
  } catch (error) {
    notify(error instanceof Error ? error.message : t("작업을 마치지 못했습니다"), title);
    return null;
  } finally {
    setActionBusy(button, false, t("처리 중…"));
  }
}

function updateSentenceDraft(sentenceId: string, replacement: string) {
  const updated = replaceTextSentence(translationDraftText, sentenceDrafts, sentenceId, replacement);
  translationDraftText = updated.text;
  sentenceDrafts = updated.sentences;
  return updated;
}

function showWorkflowError(target: "source" | "punctuation", message: string): void {
  const notice = must(`#${target}Message`);
  notice.className = "workflow-notice is-error";
  notice.textContent = message;
  notice.hidden = false;
  notify(message, target === "source" ? t("원문") : t("표점 원문"));
}

async function saveSourceDraft(): Promise<boolean> {
  if (editorMutationBusy()) return false;
  if (!view) return false;
  if (view.source.state === "confirmed" && !sourceEditingConfirmed) return false;
  const text = must<HTMLTextAreaElement>("#sourceDraftText").value;
  if (!text.trim()) {
    showWorkflowError("source", t("원문을 입력하세요."));
    return false;
  }
  const button = must<HTMLButtonElement>("#btnSaveSourceDraft");
  workspaceSaving = true;
  const savingDocumentId = view.document.id;
  must<HTMLTextAreaElement>("#sourceDraftText").readOnly = true;
  renderSaveState();
  setActionBusy(button, true, t("저장 중…"));
  try {
    const result = await api.editor.saveSourceDraft({
      documentNodeId: view.document.id,
      contentText: text,
      originKind: "manual",
      expectedLockVersion: view.source.lockVersion,
    });
    if (view?.document.id !== savingDocumentId) return false;
    if (!result.ok) {
      showWorkflowError("source", result.error.message);
      return false;
    }
    applyView(result.data, { saved: true });
    must("#sbSaved").textContent = nowHM();
    notify(t("원문안을 새 버전으로 저장했습니다"), t("원문"));
    return true;
  } catch (error) {
    showWorkflowError("source", error instanceof Error ? error.message : t("원문안을 저장하지 못했습니다."));
    return false;
  } finally {
    workspaceSaving = false;
    renderDraftWorkspaces();
    renderSaveState();
    setActionBusy(button, false, t("저장 중…"));
  }
}

async function confirmSource(): Promise<void> {
  if (!view || editorMutationBusy()) return;
  if (view.source.state === "confirmed" && (!sourceEditingConfirmed || !sourceDirty)) return;
  if (sourceDirty && !(await saveSourceDraft())) return;
  const button = must<HTMLButtonElement>("#btnConfirmSource");
  setActionBusy(button, true, t("확정 중…"));
  try {
    const result = await api.editor.confirmSource({
      documentNodeId: view.document.id,
      expectedLockVersion: view.source.lockVersion,
    });
    if (!actionResultIsCurrent(button)) return;
    if (!result.ok) {
      showWorkflowError("source", result.error.message);
      return;
    }
    applyView(result.data);
    must("#sbSaved").textContent = nowHM();
    setWorkspace("translation", true);
    notify(t("원문을 확정했습니다. 전체 번역을 시작하거나 표점을 작성할 수 있습니다"), t("원문 확정"));
  } catch (error) {
    showWorkflowError("source", error instanceof Error ? error.message : t("원문안을 확정하지 못했습니다."));
  } finally {
    setActionBusy(button, false, t("확정 중…"));
  }
}

function structureValidationMessage(text: string): string | null {
  if (structureDrafts === undefined) return null;
  const limit = codepointLength(text);
  const mode = must<HTMLSelectElement>("#punctuationMode").value;
  const allowed = new Set<StructureSpanKind>(mode === "poetry" ? ["paragraph", "stanza", "couplet", "verse_line"] : ["paragraph", "sentence"]);
  const keys = new Set<string>();
  for (const span of structureDrafts) {
    if (!span.spanKey.trim() || keys.has(span.spanKey)) return t("구조 범위의 식별자가 중복되었습니다.");
    keys.add(span.spanKey);
    if (!allowed.has(span.spanKind)) return ui`${mode === "poetry" ? t("운문") : t("산문")} 구조에 맞지 않는 범위 종류가 있습니다.`;
    if (!Number.isInteger(span.ordinal) || span.ordinal < 1) return t("구조 순서는 1 이상의 정수여야 합니다.");
    if (!Number.isInteger(span.codepointFrom) || !Number.isInteger(span.codepointTo)) return t("구조 위치는 정수여야 합니다.");
    if (span.codepointFrom < 0 || span.codepointTo <= span.codepointFrom || span.codepointTo > limit) {
      return ui`구조 ${span.ordinal}의 범위가 표점문 길이(0–${limit})를 벗어났습니다.`;
    }
  }
  const byKey = new Map(structureDrafts.map((span) => [span.spanKey, span]));
  for (const span of structureDrafts) {
    if (span.parentSpanKey && (!keys.has(span.parentSpanKey) || span.parentSpanKey === span.spanKey)) return ui`구조 ${span.ordinal}의 상위 범위를 찾을 수 없습니다.`;
    const parent = span.parentSpanKey ? byKey.get(span.parentSpanKey) : undefined;
    const validRoot = span.spanKind === "paragraph" || (mode === "poetry" && span.spanKind === "stanza");
    const validParent = !!parent && (
      (mode === "prose" && span.spanKind === "sentence" && parent.spanKind === "paragraph") ||
      (mode === "poetry" && span.spanKind === "couplet" && parent.spanKind === "stanza") ||
      (mode === "poetry" && span.spanKind === "verse_line" && (parent.spanKind === "paragraph" || parent.spanKind === "couplet"))
    );
    if ((!parent && !validRoot) || (parent && !validParent)) return ui`구조 ${span.ordinal}의 상위 범위 관계가 올바르지 않습니다.`;
  }
  return null;
}

async function createPunctuationDraft(): Promise<void> {
  if (!view || editorMutationBusy()) return;
  if (view.source.state !== "confirmed") {
    showWorkflowError("punctuation", t("원문안을 먼저 확정하세요."));
    return;
  }
  if (view.punctuation && view.punctuation.state !== "superseded") {
    showWorkflowError("punctuation", t("현재 원문에 대한 표점 작업안이 이미 있습니다."));
    return;
  }
  const button = must<HTMLButtonElement>("#btnCreatePunctuationDraft");
  setActionBusy(button, true, t("작업안 만드는 중…"));
  try {
    const result = await api.editor.createPunctuationDraft({
      documentNodeId: view.document.id,
      structureMode: must<HTMLSelectElement>("#punctuationMode").value as "prose" | "poetry",
      expectedSourceLockVersion: view.source.lockVersion,
    });
    if (!actionResultIsCurrent(button)) return;
    if (!result.ok) {
      showWorkflowError("punctuation", result.error.message);
      return;
    }
    if (!result.data.punctuation) {
      showWorkflowError("punctuation", t("표점 작업안이 생성되지 않았습니다."));
      return;
    }
    applyView(result.data);
    must("#sbSaved").textContent = nowHM();
    must<HTMLTextAreaElement>("#punctuationDraftText").focus();
    notify(t("확정 원문을 복사해 표점 작업안을 만들었습니다. 표점과 구조를 편집한 뒤 저장·확정하세요"), t("표점 원문"));
  } catch (error) {
    showWorkflowError("punctuation", error instanceof Error ? error.message : t("표점 작업안을 만들지 못했습니다."));
  } finally {
    setActionBusy(button, false, t("작업안 만드는 중…"));
  }
}

async function savePunctuationDraft(): Promise<boolean> {
  if (editorMutationBusy()) return false;
  if (!view) return false;
  if (previewedPunctuationSuggestion()) {
    notify(t("AI 제안을 먼저 적용하거나 작업안으로 전환한 뒤 저장하세요."), t("표점 원문"));
    return false;
  }
  if (view.source.state !== "confirmed") {
    showWorkflowError("punctuation", t("원문안을 먼저 확정하세요."));
    return false;
  }
  const punctuation = view.punctuation;
  if (punctuation?.state === "confirmed" && !punctuationEditingConfirmed) return false;
  if (!punctuation || punctuation.state === "superseded") {
    showWorkflowError("punctuation", t("현재 확정 원문으로 표점 작업안을 먼저 만드세요."));
    return false;
  }
  const text = must<HTMLTextAreaElement>("#punctuationDraftText").value;
  if (!text.trim()) {
    showWorkflowError("punctuation", t("표점문을 입력하세요."));
    return false;
  }
  const structureError = structureValidationMessage(text);
  if (structureError) {
    showWorkflowError("punctuation", structureError);
    return false;
  }
  const button = must<HTMLButtonElement>("#btnSavePunctuationDraft");
  workspaceSaving = true;
  const savingDocumentId = view.document.id;
  must<HTMLTextAreaElement>("#punctuationDraftText").readOnly = true;
  renderSaveState();
  setActionBusy(button, true, t("저장 중…"));
  try {
    const result = await api.editor.savePunctuationDraft({
      documentNodeId: view.document.id,
      punctuatedText: text,
      structureMode: must<HTMLSelectElement>("#punctuationMode").value as "prose" | "poetry",
      structureSpans: structureDrafts,
      expectedLockVersion: punctuation.lockVersion,
    });
    if (view?.document.id !== savingDocumentId) return false;
    if (!result.ok) {
      showWorkflowError("punctuation", result.error.message);
      return false;
    }
    applyView(result.data, { saved: true });
    must("#sbSaved").textContent = nowHM();
    notify(t("표점 원문과 구조를 새 버전으로 저장했습니다"), t("표점 원문"));
    return true;
  } catch (error) {
    showWorkflowError("punctuation", error instanceof Error ? error.message : t("표점 원문을 저장하지 못했습니다."));
    return false;
  } finally {
    workspaceSaving = false;
    renderDraftWorkspaces();
    renderSaveState();
    setActionBusy(button, false, t("저장 중…"));
  }
}

async function confirmPunctuation(): Promise<void> {
  if (!view || editorMutationBusy()) return;
  if (previewedPunctuationSuggestion()) {
    notify(t("AI 제안을 먼저 적용하거나 작업안으로 전환한 뒤 확정하세요."), t("표점 원문"));
    return;
  }
  if (view.punctuation?.state === "confirmed" && (!punctuationEditingConfirmed || !punctuationDirty)) return;
  if (punctuationDirty && !(await savePunctuationDraft())) return;
  const punctuation = view.punctuation;
  if (!punctuation || punctuation.state === "superseded") {
    showWorkflowError("punctuation", t("현재 확정 원문의 표점 작업안을 먼저 만드세요."));
    return;
  }
  const button = must<HTMLButtonElement>("#btnConfirmPunctuation");
  setActionBusy(button, true, t("확정 중…"));
  try {
    const result = await api.editor.confirmPunctuation({
      documentNodeId: view.document.id,
      expectedLockVersion: punctuation.lockVersion,
    });
    if (!actionResultIsCurrent(button)) return;
    if (!result.ok) {
      showWorkflowError("punctuation", result.error.message);
      return;
    }
    applyView(result.data);
    must("#sbSaved").textContent = nowHM();
    if (translationReady()) setWorkspace("translation", true);
  } catch (error) {
    showWorkflowError("punctuation", error instanceof Error ? error.message : t("표점 원문을 확정하지 못했습니다."));
  } finally {
    setActionBusy(button, false, t("확정 중…"));
  }
}

async function createTranslationDraft(): Promise<void> {
  if (!view || editorMutationBusy() || !translationReady() || view.translation) return;
  const button = must<HTMLButtonElement>("#btnCreateTranslationDraft");
  setActionBusy(button, true, t("초안 만드는 중…"));
  try {
    const result = await api.editor.createTranslationDraft({
      documentNodeId: view.document.id,
      expectedSourceLockVersion: view.source.lockVersion,
      fullText: true,
      expectedPunctuationLockVersion: 0,
    });
    const data = unwrap(result, t("사람 번역 초안"));
    if (!data || !actionResultIsCurrent(button)) return;
    applyView(data);
    setWorkspace("translation", true);
    setView("full");
    must("#sbSaved").textContent = nowHM();
    notify(t("빈 번역 작업안을 만들었습니다. 번역 전문을 입력하세요"), t("사람 번역 초안"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("사람 번역 초안을 만들지 못했습니다."), t("사람 번역 초안"));
  } finally {
    setActionBusy(button, false, t("초안 만드는 중…"));
  }
}

async function resetTranslationDraft(): Promise<void> {
  if (!view || editorMutationBusy() || !translationReady() || !view.translation || view.translation.isCurrentDependencies) return;
  if (!window.confirm(t("이전 번역안은 이력에 보존하고, 현재 원문에 맞는 빈 번역 작업안을 새로 만드시겠습니까?"))) return;
  const button = must<HTMLButtonElement>("#btnResetTranslationDraft");
  setActionBusy(button, true, t("작업안 만드는 중…"));
  try {
    const result = await api.editor.resetTranslationDraft({
      documentNodeId: view.document.id,
      expectedSourceLockVersion: view.source.lockVersion,
      fullText: true,
      expectedPunctuationLockVersion: 0,
      expectedTranslationLockVersion: view.translation.lockVersion,
    });
    const data = unwrap(result, t("현재 원문 번역 작업안"));
    if (!data || !actionResultIsCurrent(button)) return;
    applyView(data);
    setWorkspace("translation", true);
    setView("full");
    must("#sbSaved").textContent = nowHM();
    notify(t("이전 번역은 이력에 보존하고 현재 원문의 빈 번역 작업안을 만들었습니다"), t("번역 작업안"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("현재 원문의 번역 작업안을 만들지 못했습니다."), t("번역 작업안"));
  } finally {
    setActionBusy(button, false, t("작업안 만드는 중…"));
  }
}

function showEditorError(msg: string, title = t("편집기를 열 수 없습니다")): void {
  must("#editorError").hidden = false;
  must("#ws").hidden = true;
  must("#editorErrorTitle").textContent = title;
  must("#editorErrorMessage").textContent = msg;
}

async function loadEditor(id: string): Promise<void> {
  if (editorMutationBusy()) return;
  const serial = ++editorLoadSerial;
  const editSerial = editorEditSerial;
  let result: Awaited<ReturnType<typeof api.editor.get>>;
  try {
    result = await api.editor.get(id);
  } catch (error) {
    if (serial === editorLoadSerial && editSerial === editorEditSerial && !editorMutationBusy()) showEditorError(error instanceof Error ? error.message : t("편집기 연결에 실패했습니다."));
    return;
  }
  if (serial !== editorLoadSerial || editSerial !== editorEditSerial || editorMutationBusy()) return;
  if (!result.ok) {
    showEditorError(result.error.message || t("문서 데이터를 불러오지 못했습니다."));
    return;
  }
  const v = result.data;
  persistDoc(id);
  const url = new URL(location.href);
  url.searchParams.set("doc", id);
  history.replaceState(null, "", url);
  must("#editorError").hidden = true;
  must("#ws").hidden = false;
  applyView(v);
  await loadPunctuationSuggestion(id);
  renderSidebar(tree(), { currentDocId: id });
}

async function attachReference(): Promise<void> {
  if (!view || editorMutationBusy()) return;
  const button = must<HTMLButtonElement>("#btnAttachReference");
  const before = new Set(view.referenceAssets.map((asset) => asset.id));
  setActionBusy(button, true, t("첨부 중…"));
  must<HTMLButtonElement>("#btnAttachReferenceEmpty").disabled = true;
  try {
    const result = await api.editor.attachReference(view.document.id);
    if (!actionResultIsCurrent(button)) return;
    if (!result.ok) {
      notify(result.error.message, t("참고 자료"));
      return;
    }
    if (!result.data) return;
    const added = result.data.referenceAssets.find((asset) => !before.has(asset.id));
    view.referenceAssets = result.data.referenceAssets;
    activeReferenceId = added?.id ?? activeReferenceId ?? view.referenceAssets[0]?.id ?? null;
    clearReferencePreview();
    renderReferencePanel();
    notify(added ? ui`${added.originalFilename}을 첨부했습니다` : t("이미 연결된 참고 자료입니다"), t("참고 자료"));
  } catch (error) {
    notify(error instanceof Error ? error.message : t("참고 자료를 첨부하지 못했습니다."), t("참고 자료"));
  } finally {
    setActionBusy(button, false, t("첨부 중…"));
    must<HTMLButtonElement>("#btnAttachReferenceEmpty").disabled = false;
  }
}

async function openActiveReference(): Promise<void> {
  if (!view || !activeReferenceId) return;
  const result = await api.editor.openReference(view.document.id, activeReferenceId);
  if (!result.ok) notify(result.error.message, t("참고 자료"));
}

function pageCmd(id: string): boolean {
  const i = editing() ? blocks.findIndex((b) => b.key === active) : -1;
  switch (id) {
    case "refpane":
      togglePane("ref");
      return true;
    case "ctxpane":
      togglePane("ctx");
      return true;
    case "v-source":
      if (workspace !== "translation") setWorkspace("translation");
      if (workspace !== "translation") return true;
      setView("source");
      return true;
    case "v-parallel":
      if (workspace !== "translation") setWorkspace("translation");
      if (workspace !== "translation") return true;
      setView("parallel");
      return true;
    case "v-full":
      if (workspace !== "translation") setWorkspace("translation");
      if (workspace !== "translation") return true;
      setView("full");
      return true;
    case "struct":
      must<HTMLInputElement>("#chkStruct").click();
      return true;
    case "keys":
      must<HTMLInputElement>("#chkKeys").click();
      return true;
    case "prepare":
    case "run":
      openPreparation();
      return true;
    case "diff":
      openDiff();
      return true;
    case "confirm": {
      if (workspace === "source") {
        void confirmSource();
        return true;
      }
      if (workspace === "punctuation") {
        void confirmPunctuation();
        return true;
      }
      if (workspace === "segmentation") {
        notify(t("분절은 확정된 표점 원문에서 생성된 읽기 전용 참조입니다"), t("분절"));
        return true;
      }
      const b = must<HTMLButtonElement>("#btnConfirm");
      if (b.hidden) notify(t("이미 확정된 번역안입니다. 수정하려면 새 번역안을 만드세요"), t("확정"));
      else if (b.disabled) notify(b.title, t("확정"));
      else openConfirm();
      return true;
    }
    case "merge":
    case "split":
    case "link":
      if (!editing()) {
        notify(t("확정본은 읽기 전용입니다. 새 번역안으로 수정한 뒤 편집하세요"), t("블록"));
        return true;
      }
      if (i < 0) {
        notify(t("대조 보기에서 블록을 먼저 선택하세요"), t("블록"));
        return true;
      }
      if (id === "merge") {
        if (i === blocks.length - 1) notify(t("마지막 블록은 다음 블록과 합칠 수 없습니다"), t("블록"));
        else void mergeAt(i);
      } else if (id === "split") openSplit(i);
      else openLink(i);
      return true;
    case "find":
      if (workspace !== "translation") return false;
      documentFind.open(selectedPhrase()); return true;
    case "export":
      reviewExport.open(); return true;
  }
  return false;
}

function pageKeys(e: KeyboardEvent, m: boolean): void {
  if (workspace === "translation" && layout !== "reading" && editorAids.key(e)) return;
  if (m && e.shiftKey && !e.altKey && e.code === "KeyF") { e.preventDefault(); concordance.open(selectedPhrase()); return; }
  const typing = (e.target as HTMLElement).matches("textarea,input,[contenteditable=true]");
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyS") {
    e.preventDefault();
    if (workspace === "translation" && layout === "reading") void readingStudy.save();
    else if (workspace === "source" && sourceDirty) void saveSourceDraft();
    else if (workspace === "punctuation" && punctuationDirty) void savePunctuationDraft();
    else if (workspace === "translation" && dirty && !translationSaving) void saveDraft();
    return;
  }
  if (m && !e.shiftKey && !e.altKey && /^Digit[1-3]$/.test(e.code)) {
    e.preventDefault();
    const views: Layout[] = ["source", "parallel", "full"];
    const v = views[Number(e.code.slice(5)) - 1];
    if (v) setView(v);
    return;
  }
  if (m && !e.shiftKey && !e.altKey && e.code === "KeyD") {
    e.preventDefault();
    openDiff();
    return;
  }
  if (m && e.shiftKey && e.key === "Enter") {
    e.preventDefault();
    void pageCmd("confirm");
    return;
  }
  if (m && e.altKey && !e.shiftKey && (e.code === "ArrowUp" || e.code === "ArrowDown")) {
    e.preventDefault();
    const focusedRow = (e.target as HTMLElement).closest<HTMLElement>(".brow");
    const i = focusedRow ? Number(focusedRow.dataset.i) : blocks.findIndex((b) => b.key === active);
    if (!Number.isInteger(i) || i < 0) {
      notify(t("대조 보기에서 블록을 먼저 선택하세요"), t("블록 순서"));
      return;
    }
    void moveBlock(i, e.code === "ArrowUp" ? "up" : "down");
    return;
  }
  if (m && e.altKey) {
    const map: Record<string, string> = { KeyR: "refpane", KeyM: "merge", KeyS: "split", KeyL: "link", KeyK: "prepare" };
    const cmdId = map[e.code];
    if (cmdId) {
      e.preventDefault();
      void pageCmd(cmdId);
    }
  }
  if (!typing && e.key === "Escape") {
    active = null;
    renderRows();
  }
}

must("#tbRef").innerHTML = ic("image");
must("#tbCtx").innerHTML = ic("panel");
must("#tbRef").addEventListener("click", () => togglePane("ref"));
must("#tbCtx").addEventListener("click", () => togglePane("ctx"));
must("#btnAttachReference").addEventListener("click", () => void attachReference());
must("#btnAttachReferenceEmpty").addEventListener("click", () => void attachReference());
must("#btnOpenReference").addEventListener("click", () => void openActiveReference());
must<HTMLSelectElement>("#referenceSelect").addEventListener("change", (event) => {
  activeReferenceId = (event.currentTarget as HTMLSelectElement).value;
  clearReferencePreview();
  renderReferencePanel();
});
must("#btnPrepare").addEventListener("click", openPreparation);
must("#translationRunIndicator").addEventListener("click", openPreparationDialog);
const refPref = store.get("munhae.ref");
togglePane("ref", refPref ? refPref === "0" : innerWidth < 1500);
togglePane("ctx", store.get("munhae.ctx") !== "1");

must("#workflow").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-workspace]");
  if (!button || button.disabled) return;
  setWorkspace(button.dataset.workspace as Workspace);
});
must("#workflow").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = $$<HTMLButtonElement>("#workflow [data-workspace]").filter((button) => !button.hidden && !button.disabled);
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const target = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  buttons.forEach((button, i) => { button.tabIndex = i === target ? 0 : -1; });
  buttons[target]?.focus();
});
must("#btnWorkflowTranslation").addEventListener("click", () => setWorkspace("translation"));

must<HTMLTextAreaElement>("#sourceDraftText").addEventListener("input", () => {
  if (must<HTMLTextAreaElement>("#sourceDraftText").readOnly) return;
  editorEditSerial += 1;
  sourceDirty = true;
  renderDraftWorkspaces();
});
must("#btnEditSource").addEventListener("click", () => {
  if (view?.source.state !== "confirmed" || editorMutationBusy()) return;
  sourceEditingConfirmed = true;
  renderDraftWorkspaces();
  must<HTMLTextAreaElement>("#sourceDraftText").focus();
});
must("#btnCancelSourceEdit").addEventListener("click", () => {
  if (!sourceEditingConfirmed || editorMutationBusy()) return;
  sourceEditingConfirmed = false;
  sourceDirty = false;
  renderDraftWorkspaces();
  must<HTMLButtonElement>("#btnEditSource").focus();
});
must("#btnEditPunctuation").addEventListener("click", () => {
  if (view?.punctuation?.state !== "confirmed" || editorMutationBusy() || punctuationApplying) return;
  if (punctuationPreviewing) showPunctuationSuggestion(false);
  punctuationEditingConfirmed = true;
  structureDrafts = undefined;
  renderDraftWorkspaces();
  must<HTMLTextAreaElement>("#punctuationDraftText").focus();
});
must("#btnCancelPunctuationEdit").addEventListener("click", () => {
  if (!punctuationEditingConfirmed || editorMutationBusy() || punctuationApplying) return;
  punctuationEditingConfirmed = false;
  punctuationDirty = false;
  structureDrafts = undefined;
  if (punctuationPreviewing) showPunctuationSuggestion(false);
  renderDraftWorkspaces();
  must<HTMLButtonElement>("#btnEditPunctuation").focus();
});
must<HTMLTextAreaElement>("#punctuationDraftText").addEventListener("input", () => {
  if (must<HTMLTextAreaElement>("#punctuationDraftText").readOnly) return;
  editorEditSerial += 1;
  punctuationDirty = true;
  structureDrafts = undefined;
  renderDraftWorkspaces();
});
must<HTMLSelectElement>("#punctuationMode").addEventListener("change", () => {
  if (editorMutationBusy() || (view?.punctuation?.state === "confirmed" && !punctuationEditingConfirmed)) return;
  editorEditSerial += 1;
  if (!view?.punctuation || view.punctuation.state === "superseded") {
    renderAuxiliaryRunControls();
    updateDraftActionDisabled();
    return;
  }
  punctuationDirty = true;
  structureDrafts = undefined;
  renderDraftWorkspaces();
});
must<HTMLSelectElement>("#punctuationAgent").addEventListener("change", () => { renderPunctuationPreparationSettings(); renderAuxiliaryRunControls(); });
must("#btnSuggestPunctuation").addEventListener("click", openPunctuationPreparation);
must("#punctuationPrepBack").addEventListener("click", () => {
  punctuationProgressMode = false;
  renderAuxiliaryRunControls();
});
must("#punctuationPrepRun").addEventListener("click", () => void startPunctuationSuggestion());
for (const selector of ["#punctuationPrepClose", "#punctuationPrepCloseTop"]) {
  must(selector).addEventListener("click", () => must<HTMLDialogElement>("#dlgPunctuation").close());
}
must("#dlgPunctuation").addEventListener("close", () => must<HTMLButtonElement>("#btnSuggestPunctuation").focus({ preventScroll: true }));
must("#punctuationPrepReview").addEventListener("click", () => {
  must<HTMLDialogElement>("#dlgPunctuation").close();
  setWorkspace("punctuation");
  showPunctuationSuggestion(true);
  must<HTMLTextAreaElement>("#punctuationDraftText").focus();
});
must("#punctuationRetrySettings").addEventListener("click", queuePreparationSettingsSave);
must("#punctuationModelSettings").addEventListener("change", event => {
  const field = event.target as HTMLSelectElement;
  if (!appConfig || !field.dataset.prepModelSetting || activeAuxiliaryKind() !== null || aiStarting || aiRun?.state === "running") return;
  if (!changePrepModelSetting(appConfig, agentProbe(selectedPunctuationAgent()), selectedPunctuationAgent(), field.dataset.prepModelSetting, field.value)) return;
  renderPunctuationPreparationSettings();
  renderPreparationSettings();
  queuePreparationSettingsSave();
});
must("#btnCancelPunctuation").addEventListener("click", () => void cancelAuxiliaryRun());
must("#btnApplyPunctuationSuggestion").addEventListener("click", () => void applyCurrentPunctuationSuggestion());
must("#btnViewPunctuationDraft").addEventListener("click", () => showPunctuationSuggestion(false));
must("#btnViewPunctuationSuggestion").addEventListener("click", () => showPunctuationSuggestion(true));
must("#btnSaveSourceDraft").addEventListener("click", () => void saveSourceDraft());
must("#btnConfirmSource").addEventListener("click", () => void confirmSource());
must("#btnCreatePunctuationDraft").addEventListener("click", () => void createPunctuationDraft());
must("#btnSavePunctuationDraft").addEventListener("click", () => void savePunctuationDraft());
must("#btnConfirmPunctuation").addEventListener("click", () => void confirmPunctuation());
must("#btnCreateTranslationDraft").addEventListener("click", () => void createTranslationDraft());
must("#btnResetTranslationDraft").addEventListener("click", () => void resetTranslationDraft());
configureComparisonResize(must("#viewParallel"), must("#comparisonDivider"), resizeSentenceEditors);
configureComparisonResize(must("#viewFull"), must("#bookDivider"), resizeSentenceEditors, "munhae.book.sourceRatio");
$$(".gutter").forEach((g) =>
  g.addEventListener("pointerdown", (e) => {
    const ws = must("#ws");
    const side = g.dataset.side;
    const v = side === "l" ? "--lw" : "--rw";
    const start = e.clientX;
    const startW = parseFloat(getComputedStyle(ws).getPropertyValue(v)) || (side === "l" ? 260 : 340);
    g.classList.add("is-drag");
    g.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    const mv = (ev: PointerEvent): void => {
      const d = ev.clientX - start;
      const w = side === "l" ? Math.min(460, Math.max(200, startW + d)) : Math.min(560, Math.max(280, startW - d));
      ws.style.setProperty(v, `${w}px`);
    };
    const up = (): void => {
      g.classList.remove("is-drag");
      document.body.style.cursor = "";
      g.removeEventListener("pointermove", mv);
      g.removeEventListener("pointerup", up);
    };
    g.addEventListener("pointermove", mv);
    g.addEventListener("pointerup", up);
  }),
);

must("#viewSeg").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b instanceof HTMLElement && b.dataset.view) setView(b.dataset.view as Layout);
});
must<HTMLInputElement>("#chkStruct").addEventListener("change", (e) =>
  document.body.classList.toggle("show-struct", (e.target as HTMLInputElement).checked),
);
must<HTMLInputElement>("#chkKeys").addEventListener("change", (e) =>
  document.body.classList.toggle("show-keys", (e.target as HTMLInputElement).checked),
);
must("#rtabs").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b instanceof HTMLElement && b.dataset.tab) setTab(b.dataset.tab);
});
document.addEventListener("click", (e) => {
  const g = (e.target as HTMLElement).closest("[data-goto]");
  if (g instanceof HTMLElement && g.dataset.goto) setTab(g.dataset.goto);
});
const src = must("#sourceText");
src.addEventListener("mouseover", (e) => {
  const a = (e.target as HTMLElement).closest(".anchor");
  if (a instanceof HTMLElement && a.dataset.key) setHot([a.dataset.key]);
});
src.addEventListener("mouseout", (e) => {
  const t = e.target as HTMLElement;
  const rel = e.relatedTarget as HTMLElement | null;
  if (t.closest(".anchor") && !rel?.closest(".anchor")) setHot([]);
});
src.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest(".anchor");
  if (!(a instanceof HTMLElement) || !a.dataset.key) return;
  const b = shownBlocks().find((x) => x.anchors.includes(a.dataset.key ?? ""));
  if (b) {
    active = b.key;
    setHot(b.anchors);
    setView("parallel");
    renderRows();
  }
});

const translationViewSettings = must<HTMLElement>("#translationViewSettings");
translationViewSettings.addEventListener("toggle", () => must("#btnTranslationView").setAttribute("aria-expanded", String(translationViewSettings.matches(":popover-open"))));
onReadingTypeChange(resizeSentenceEditors);
must("#alignmentReviewOnly").addEventListener("change", () => { renderComparisonState(); resizeSentenceEditors(); });
must("#parallelSource").addEventListener("change", () => {
  parallelSource = must<HTMLSelectElement>("#parallelSource").value === "punctuation" ? "punctuation" : "source";
  store.set("munhae.parallel-source", parallelSource);
  reviewComments.cancelSelection();
  renderRows();
  renderEditingLocks();
  highlightBookSource(selectedSentenceId ?? sentenceDrafts[0]?.id ?? "");
});
must("#bookSourceMode").addEventListener("change", () => {
  must<HTMLSelectElement>("#parallelSource").value = must<HTMLSelectElement>("#bookSourceMode").value;
  must("#parallelSource").dispatchEvent(new Event("change"));
});
must("#comparisonQuery").addEventListener("input", () => { renderComparisonState(); resizeSentenceEditors(); });
must("#comparisonFilter").addEventListener("change", () => { renderComparisonState(); resizeSentenceEditors(); });
$$(".editor-tool-popover").forEach((popover) => {
  popover.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button") && popover.matches(":popover-open")) popover.hidePopover();
  }, { capture: true });
});
function renderComparisonFilterButton(): void {
  const active = !!must<HTMLInputElement>("#comparisonQuery").value.trim() || must<HTMLSelectElement>("#comparisonFilter").value !== "all" || must<HTMLInputElement>("#alignmentReviewOnly").checked;
  const button = must("#btnComparisonFilter");
  button.classList.toggle("is-filtered", active);
  button.setAttribute("aria-label", active ? t("대조 문장 필터 · 적용 중") : t("대조 문장 필터"));
}
must("#btnDocumentFind").addEventListener("click", () => documentFind.open(selectedPhrase()));
must("#btnConcordance").addEventListener("click", () => concordance.open(selectedPhrase()));
must("#btnQuickTerm").addEventListener("click", () => quickTerm.open(selectedPhrase()));
must("#btnDictionary").addEventListener("click", () => dictionary.open({ query: selectedPhrase() }));
must("#btnReadingStudy").addEventListener("click", () => { must("#researchTools").hidePopover(); setView("reading"); });
must("#btnDictionaryContext").addEventListener("click", () => dictionary.open({ query: selectedPhrase() }));
must("#btnTranslationChecks").addEventListener("click", () => translationChecks.open());
must("#btnReviewExport").addEventListener("click", () => reviewExport.open());
must("#btnPreviousSentence").addEventListener("click", () => moveSentence(-1));
must("#btnNextSentence").addEventListener("click", () => moveSentence(1));
function replaceGroupUnits(units: TextSentence[], links: typeof sentenceLinks): void {
  const previous = new Map(sentenceDrafts.map(sentence => [sentence.id, sentence.text]));
  sentenceDrafts = trimTextSentences(translationDraftText, units);
  for (const sentence of sentenceDrafts) if (previous.get(sentence.id) !== sentence.text) savedGroupTexts.set(sentence.id, sentence.text);
  sentenceLinks = links;
  must<HTMLTextAreaElement>("#fullTranslationInput").value = translationDraftText;
  groupStructureDirty = true; dirty = true; editingSentenceId = null;
  editorAids.record();
  must("#bookGroups").replaceChildren();
  renderRows(); renderFull(); renderStrip();
}

function openGroupOperation(id: string, split: boolean): void {
  if (!editing() || editorMutationBusy() || reviewComments.isSelecting()) return;
  const index = sentenceDrafts.findIndex(sentence => sentence.id === id);
  const sentence = sentenceDrafts[index];
  const link = sentenceLinks.find(link => link.sentenceId === id);
  if (!sentence || !link?.groupId) return;
  const field = Array.from(document.querySelectorAll<HTMLTextAreaElement>("#rows textarea, #bookGroups textarea")).find(field => field.dataset.sentenceEdit === id && field.getClientRects().length);
  const splitAt = field ? textareaRange(sentence.text, 0, field.selectionStart)?.quote.length ?? 0 : bookGroupCaret(must("#bookGroups"), id) ?? 0;
  if (split && (!sentence.text.slice(0, splitAt).trim() || !sentence.text.slice(splitAt).trim())) {
    notify("번역문 안에서 나눌 위치에 커서를 놓은 다음 묶음 나누기를 누르세요."); return;
  }
  const cuts: number[] = [];
  if (split && punctuationProjection && view?.punctuation?.state === "confirmed") {
    Array.from(view.punctuation.punctuatedText).forEach((char, i) => {
      const point = punctuationProjection!.sourceBoundaryByPunctuationBoundary[i + 1];
      if (char === "。" && point !== undefined && link.spans.some(span => span.from < point) && link.spans.some(span => span.to > point)) cuts.push(point);
    });
  }
  if (split && !cuts.length) { notify("이 묶음 안에는 나눌 수 있는 표점 경계가 없습니다. 줄바꿈은 같은 묶음 안에서 사용할 수 있습니다."); return; }
  const next = sentenceDrafts[index + 1];
  if (!split && !next) return;
  const dialog = document.createElement("dialog"); dialog.className = "group-operation-dialog";
  const previewText = split ? sentence.text.slice(0, splitAt) + "\n── 나눌 위치 ──\n" + sentence.text.slice(splitAt) : Array.from(translationDraftText).slice(sentence.from, next!.to).join("");
  dialog.innerHTML = `<h2>${split ? "연결 묶음 나누기" : "연결 묶음 합치기"}</h2><p>${split ? "번역은 커서 위치에서 나눕니다. 대응 원문을 나눌 표점 경계를 선택하세요." : "다음 번역 묶음과 원문 범위를 하나로 합칩니다. 번역 내용은 그대로 유지됩니다."}</p><pre>${esc(previewText)}</pre>${split ? `<select aria-label="원문 분할 경계">${[...new Set(cuts)].map(cut => `<option value="${cut}">${esc(sourceCodepoints.slice(Math.max(link.spans[0]!.from, cut - 12), cut).join(""))} 。 | ${esc(sourceCodepoints.slice(cut, cut + 12).join(""))}</option>`).join("")}</select>` : ""}<div class="sentence-actions"><button type="button" data-cancel>취소</button><button type="button" data-apply>${split ? "나누기" : "합치기"}</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-apply]")!.addEventListener("click", () => {
    const newId = crypto.randomUUID();
    if (split) {
      const cut = Number(dialog.querySelector("select")!.value);
      const ranges = (left: boolean) => link.spans.flatMap(span => {
        const from = left ? span.from : Math.max(span.from, cut);
        const to = left ? Math.min(span.to, cut) : span.to;
        return to > from ? [{ from, to, quote: sourceCodepoints.slice(from, to).join("") }] : [];
      });
      const boundary = sentence.from + Array.from(sentence.text.slice(0, splitAt)).length;
      replaceGroupUnits([...sentenceDrafts.slice(0, index), { ...sentence, to: boundary }, { ...sentence, id: newId, from: boundary }, ...sentenceDrafts.slice(index + 1)],
        [...sentenceLinks.filter(item => item.sentenceId !== id), { sentenceId: id, groupId: link.groupId, spans: ranges(true), needsReview: true }, { sentenceId: newId, groupId: newId, spans: ranges(false), needsReview: true }]);
    } else {
      const nextLink = sentenceLinks.find(item => item.sentenceId === next!.id);
      const spans = [...link.spans, ...(nextLink?.spans ?? [])].sort((a, b) => a.from - b.from);
      const combined: typeof spans = [];
      for (const span of spans) {
        const last = combined.at(-1);
        if (last && span.from <= last.to) { last.to = Math.max(last.to, span.to); last.quote = sourceCodepoints.slice(last.from, last.to).join(""); }
        else combined.push({ ...span });
      }
      replaceGroupUnits([...sentenceDrafts.slice(0, index), { ...sentence, to: next!.to }, ...sentenceDrafts.slice(index + 2)],
        [...sentenceLinks.filter(item => item.sentenceId !== id && item.sentenceId !== next!.id), { sentenceId: id, groupId: link.groupId, spans: combined, needsReview: true }]);
    }
    dialog.close();
  });
  dialog.showModal();
}
for (const root of [must("#rows"), must("#bookEditToolbar"), must("#bookGroups")]) root.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-split-group], [data-merge-group]");
  if (button && !button.disabled) {
    openGroupOperation(button.dataset.splitGroup ?? button.dataset.mergeGroup!, !!button.dataset.splitGroup);
    const menu = button.closest("details"); if (menu) menu.open = false;
  }
});

const bookGroups = must("#bookGroups");
const bookEditToolbar = must("#bookEditToolbar");
document.addEventListener("pointerdown", event => {
  document.querySelectorAll<HTMLDetailsElement>("#bookEditToolbar details[open], #rows .sentence-group-menu[open]").forEach(menu => { if (!menu.contains(event.target as Node)) menu.open = false; });
  if (selectedGapId && !(event.target as Element).closest?.(".book-gap-mark, dialog")) releaseBookGap();
});
/** Paragraph breaks are edited like the rest of the book: click to choose one, then ⌫ to remove it. */
function canEditBookGaps(): boolean {
  return !!view?.translation?.textLayout && view.project.storageMode === "local" && editing() && !editorMutationBusy() && !reviewComments.isSelecting();
}
function selectBookGap(id: string | null): void {
  if (!id || !canEditBookGaps()) return;
  window.getSelection()?.removeAllRanges();
  // The paragraph above stands behind the break, taking the selection back once it is released.
  const index = sentenceDrafts.findIndex(sentence => sentence.id === id);
  if (index > 0) selectedSentenceId = sentenceDrafts[index - 1]!.id;
  selectedGapId = id;
  renderBookGroups();
  highlightBookSource("");
  bookGroups.querySelector<HTMLElement>(".book-gap-mark")?.focus({ preventScroll: true });
}
function releaseBookGap(): void {
  selectedGapId = null;
  renderBookGroups();
  highlightBookSource(selectedSentenceId ?? "");
}
/** Leaves the gap for the paragraph above it, so keyboard reading continues from there. */
function clearBookGap(): void {
  releaseBookGap();
  if (selectedSentenceId) bookGroups.querySelector<HTMLElement>(`[data-book-group="${CSS.escape(selectedSentenceId)}"]`)?.focus({ preventScroll: true });
}
function confirmJoinBookGap(id: string): void {
  const index = sentenceDrafts.findIndex(sentence => sentence.id === id);
  const next = joinBookGap(translationDraftText, sentenceDrafts, id);
  if (index < 1 || next === null || !canEditBookGaps()) return;
  const clip = (text: string, head: boolean) => { const points = Array.from(text); return points.length > 40 ? head ? `${points.slice(0, 40).join("")}…` : `…${points.slice(-40).join("")}` : text; };
  const gap = Array.from(translationDraftText).slice(sentenceDrafts[index - 1]!.to, sentenceDrafts[index]!.from).join("");
  const blank = (gap.match(/\r\n|\r|\n/g) ?? []).length > 1;
  const dialog = document.createElement("dialog"); dialog.className = "group-operation-dialog";
  dialog.innerHTML = `<h2>${blank ? t("빈 줄 지우기") : t("줄바꿈 지우기")}</h2><p>${t("앞뒤 문단이 한 문단으로 이어집니다. 번역 묶음과 원문 연결은 그대로 유지됩니다.")}</p><pre>${esc(clip(sentenceDrafts[index - 1]!.text, false))} ${esc(clip(sentenceDrafts[index]!.text, true))}</pre><div class="sentence-actions"><button type="button" data-cancel>${t("취소")}</button><button type="button" data-apply autofocus>${t("지우기")}</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (dialog.returnValue !== "apply") { bookGroups.querySelector<HTMLElement>(".book-gap-mark")?.focus({ preventScroll: true }); return; }
    selectedGapId = null;
    applyFullTranslationText(next);
    bookGroups.querySelector<HTMLElement>(`[data-book-group="${CSS.escape(sentenceDrafts[index - 1]!.id)}"]`)?.focus({ preventScroll: true });
  });
  dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close());
  dialog.querySelector("[data-apply]")!.addEventListener("click", () => dialog.close("apply"));
  dialog.showModal();
}
bookEditToolbar.addEventListener("keydown", event => {
  if (event.key === "Escape") bookEditToolbar.querySelectorAll<HTMLDetailsElement>("details[open]").forEach(menu => { menu.open = false; menu.querySelector<HTMLElement>("summary")?.focus(); });
});
/** Scrolls only the given pane, and only when the target is not already fully visible. */
function revealInPane(pane: HTMLElement | null, target: HTMLElement | null | undefined): void {
  if (!pane || !target) return;
  const bounds = pane.getBoundingClientRect(), rect = target.getBoundingClientRect();
  if (rect.top >= bounds.top && rect.bottom <= bounds.bottom) return;
  pane.scrollTop += rect.top < bounds.top || rect.height > bounds.height ? rect.top - bounds.top - 24 : rect.bottom - bounds.bottom + 24;
}
/** Keeps the linked source span in view without fighting the reader's own scrolling. */
function revealBookSource(): void {
  const pane = must("#folioSourceText");
  revealInPane(pane, pane.querySelector<HTMLElement>(".book-source-highlight"));
}
bookGroups.addEventListener("focusin", event => {
  const box = (event.target as HTMLElement).closest<HTMLElement>("[data-book-group]");
  if (!box) return;
  selectedGapId = null;
  const changed = selectedSentenceId !== box.dataset.bookGroup;
  selectedSentenceId = box.dataset.bookGroup!;
  highlightBookSource(selectedSentenceId);
  renderBookGroups();
  if (changed) revealBookSource();
});
function selectBookSentence(id: string): void {
  selectedGapId = null;
  selectedSentenceId = id;
  highlightBookSource(id);
  renderBookGroups();
  must("#bookGroups").querySelector<HTMLElement>(`[data-book-group="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  revealBookSource();
}
/** Finishing returns focus to the group so keyboard reading continues from the same place. */
function setBookEditing(id: string | null, selection: { start: number; end: number } | null = null): void {
  if (id && (!editing() || editorMutationBusy() || reviewComments.isSelecting())) return;
  const finished = editingSentenceId;
  editingSentenceId = id;
  if (id) selectedSentenceId = id;
  renderBookGroups(); renderEditingLocks();
  const box = [...bookGroups.querySelectorAll<HTMLElement>("[data-book-group]")].find(item => item.dataset.bookGroup === (id ?? finished));
  if (!id) { box?.focus({ preventScroll: true }); return; }
  highlightBookSource(id); revealBookSource();
  const field = box?.querySelector<HTMLTextAreaElement>("textarea");
  if (!field) return;
  field.focus({ preventScroll: true });
  // The saved wording takes the group's old place, so the live field may start below the fold.
  revealInPane(field.closest<HTMLElement>(".folio-translation"), field);
  if (selection) {
    const text = sentenceDrafts.find(s => s.id === id)?.text ?? "";
    const at = (offset: number) => text.slice(0, offset).replace(/\r\n?/g, "\n").length;
    field.setSelectionRange(at(selection.start), at(selection.end));
  }
}
bookGroups.addEventListener("click", event => {
  const target = event.target as HTMLElement;
  const box = target.closest<HTMLElement>("[data-book-group]");
  // A click chooses a paragraph break just as it chooses a group; a drag that selected text is left alone.
  if (!box) { if (window.getSelection()?.isCollapsed !== false) selectBookGap(bookGapAtPoint(bookGroups, event.clientX, event.clientY)); return; }
  if (target.closest("[data-book-edit-done]")) { setBookEditing(null); return; }
  if (target.closest("[data-book-edit-toggle]")) {
    bookEditCollapsed = !bookEditCollapsed;
    store.set("munhae.book-edit.collapsed", bookEditCollapsed ? "1" : "0");
    renderBookGroups(); return;
  }
  const revert = target.closest<HTMLButtonElement>("[data-book-edit-revert]");
  if (revert) {
    const field = box.querySelector<HTMLTextAreaElement>("textarea"), saved = savedGroupTexts.get(box.dataset.bookGroup!);
    if (revert.disabled || !field || field.readOnly || saved === undefined) return;
    field.value = saved.replace(/\r\n?/g, "\n");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length);
    return;
  }
  selectBookSentence(box.dataset.bookGroup!);
});
// Pointing at a proof mark lights up the same change in the other text.
bookGroups.addEventListener("pointerover", event => {
  const mark = (event.target as HTMLElement).closest<HTMLElement>(".book-group.is-editing [data-change]");
  const box = mark?.closest<HTMLElement>(".book-group");
  bookGroups.querySelectorAll<HTMLElement>(".is-linked").forEach(item => { if (!mark || item.dataset.change !== mark.dataset.change) item.classList.remove("is-linked"); });
  box?.querySelectorAll<HTMLElement>(`[data-change="${mark!.dataset.change}"]`).forEach(item => item.classList.add("is-linked"));
});
bookGroups.addEventListener("dblclick", event => {
  const box = (event.target as HTMLElement).closest<HTMLElement>("[data-book-group]");
  if (!box) { selectBookGap(bookGapAtPoint(bookGroups, event.clientX, event.clientY)); return; }
  if (box.classList.contains("is-editing")) return;
  setBookEditing(box.dataset.bookGroup!, bookGroupSelection(bookGroups, box.dataset.bookGroup!));
});
bookGroups.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if ((event.target as HTMLElement).matches(".book-gap-mark")) {
    if ((event.key === "Backspace" || event.key === "Delete") && selectedGapId) { event.preventDefault(); confirmJoinBookGap(selectedGapId); }
    else if (event.key === "Escape") { event.preventDefault(); clearBookGap(); }
    return;
  }
  const box = (event.target as HTMLElement).closest<HTMLElement>("[data-book-group]");
  if (!box) return;
  if (box.classList.contains("is-editing") && (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey))) {
    event.preventDefault(); setBookEditing(null); return;
  }
  if (event.target === box && event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    const end = sentenceDrafts.find(s => s.id === box.dataset.bookGroup)?.text.length ?? 0;
    setBookEditing(box.dataset.bookGroup!, { start: end, end });
  }
});
const folioSourceText = must("#folioSourceText");
folioSourceText.addEventListener("click", event => {
  if (!window.getSelection()?.isCollapsed) return;
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-book-source]");
  if (row?.dataset.bookSource) selectBookSentence(row.dataset.bookSource);
});
folioSourceText.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-book-source]");
  if (!row?.dataset.bookSource) return;
  event.preventDefault();
  selectBookSentence(row.dataset.bookSource);
});
bookEditToolbar.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-edit-sentence]");
  if (!button || button.disabled) return;
  const id = button.dataset.editSentence!;
  if (isSentenceEditing(id)) { setBookEditing(null); return; }
  const caret = bookGroupCaret(bookGroups, id);
  setBookEditing(id, caret === null ? null : { start: caret, end: caret });
});
bookGroups.addEventListener("input", event => {
  const field = event.target as HTMLTextAreaElement;
  if (!field.matches("textarea") || field.readOnly || !isSentenceEditing(field.dataset.sentenceEdit) || editorMutationBusy()) return;
  const id = field.dataset.sentenceEdit!;
  editorEditSerial++;
  const saved = savedGroupTexts.get(id);
  const restored = saved !== undefined && field.value === saved.replace(/\r\n?/g, "\n");
  updateSentenceDraft(id, restored ? saved : field.value);
  const link = sentenceLinks.find(link => link.sentenceId === id);
  const savedLink = view?.translation?.textLayout?.links.find(item => item.sentenceId === id);
  // Returning to the saved wording also returns its alignment review, unless the links changed meanwhile.
  if (link && restored && savedLink && JSON.stringify(savedLink.spans) === JSON.stringify(link.spans)) {
    link.needsReview = savedLink.needsReview;
    if (savedLink.reviewedBy) link.reviewedBy = savedLink.reviewedBy; else delete link.reviewedBy;
  } else if (link) { link.needsReview = true; delete link.reviewedBy; }
  must<HTMLTextAreaElement>("#fullTranslationInput").value = translationDraftText;
  dirty = groupStructureDirty || translationDraftText !== view?.translation?.textContent;
  editorAids.record(`sentence:${id}`);
  renderRows(); renderFull(); renderStrip();
});

const rows = must("#rows");
rows.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  rows.querySelectorAll<HTMLDetailsElement>(".sentence-group-menu[open]").forEach(menu => {
    menu.open = false;
    menu.querySelector<HTMLElement>("summary")?.focus();
  });
});
rows.addEventListener("focusin", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-review-sentence]");
  if (row) { selectedSentenceId = row.dataset.reviewSentence!; renderComparisonState(); }
});
rows.addEventListener("click", (event) => {
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-review-sentence]");
  if (row) { selectedSentenceId = row.dataset.reviewSentence!; renderComparisonState(); }
  const editButton = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-edit-sentence]");
  if (editButton && !editButton.disabled && editing() && !editorMutationBusy() && !reviewComments.isSelecting()) {
    editingSentenceId = isSentenceEditing(editButton.dataset.editSentence) ? null : editButton.dataset.editSentence!;
    renderEditingLocks();
    if (editingSentenceId) editButton.closest("[data-sentence-group]")?.querySelector<HTMLTextAreaElement>(".sentence-edit")?.focus({ preventScroll: true });
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-edit-sentence-link]");
  if (button && !button.disabled) sentenceLinkUi.open(button.dataset.editSentenceLink!);
});
let sentenceEditorWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry && entry.contentRect.width !== sentenceEditorWidth) {
    sentenceEditorWidth = entry.contentRect.width;
    resizeSentenceEditors();
  }
}).observe(rows);
rows.addEventListener("mouseover", (e) => {
  const k = (e.target as HTMLElement).closest(".akey");
  if (k instanceof HTMLElement && k.dataset.akey) {
    setHot([k.dataset.akey]);
    return;
  }
  const r = (e.target as HTMLElement).closest(".brow");
  if (r instanceof HTMLElement) {
    const b = shownBlocks().find((x) => x.key === r.dataset.key);
    if (b && hot.join() !== b.anchors.join()) setHot(b.anchors);
  }
});
rows.addEventListener("mouseleave", () => setHot([]));
rows.addEventListener("click", (e) => {
  const r = (e.target as HTMLElement).closest(".brow");
  if (!(r instanceof HTMLElement) || !r.dataset.key) return;
  selectRow(r.dataset.key);
  const move = (e.target as HTMLElement).closest("button[data-move]");
  if (move instanceof HTMLButtonElement) {
    e.stopPropagation();
    if (!move.disabled) void moveBlock(Number(move.dataset.moveI), move.dataset.move === "up" ? "up" : "down");
    return;
  }
  const more = (e.target as HTMLElement).closest(".more");
  if (more instanceof HTMLElement) {
    e.stopPropagation();
    const rc = more.getBoundingClientRect();
    openCtx(Number(more.dataset.more), rc.right - 212, rc.bottom + 4);
  }
});
rows.addEventListener("contextmenu", (e) => {
  const r = (e.target as HTMLElement).closest(".brow");
  if (!(r instanceof HTMLElement) || !r.dataset.key) return;
  e.preventDefault();
  selectRow(r.dataset.key);
  openCtx(Number(r.dataset.i), e.clientX, e.clientY);
});
rows.addEventListener("input", (e) => {
  if (editorMutationBusy()) return;
  editorEditSerial += 1;
  const sentenceEditor = (e.target as HTMLElement).closest<HTMLTextAreaElement>(".sentence-edit");
  if (sentenceEditor && !sentenceEditor.readOnly && isSentenceEditing(sentenceEditor.dataset.sentenceEdit) && editing() && !translationSaving) {
    const full = must<HTMLTextAreaElement>("#fullTranslationInput");
    const id = sentenceEditor.dataset.sentenceEdit!;
    const updated = updateSentenceDraft(id, sentenceEditor.value);
    full.value = updated.text;
    const link = sentenceLinks.find((item) => item.sentenceId === id);
    const savedSentence = view?.translation?.textLayout?.sentences.find((item) => item.id === id);
    const savedLink = view?.translation?.textLayout?.links.find((item) => item.sentenceId === id);
    if (link) link.needsReview = sentenceEditor.value !== savedSentence?.text || (savedLink?.needsReview ?? true);
    const review = sentenceEditor.closest("[data-review-sentence]")?.querySelector<HTMLElement>("[data-sentence-review]");
    if (review) review.hidden = !!link && !link.needsReview;
    dirty = groupStructureDirty || translationDraftText !== view?.translation?.textContent;
    editorAids.record(`sentence:${id}`);
    resizeSentenceEditor(sentenceEditor);
    renderFull();
    renderStrip();
    return;
  }
  const ed = (e.target as HTMLElement).closest(".tgt-edit");
  if (ed instanceof HTMLElement) collectTranslationEdit(ed);
});
rows.addEventListener("focusout", (e) => {
  const ed = (e.target as HTMLElement).closest(".tgt-edit");
  if (!(ed instanceof HTMLElement) || !editing()) return;
  collectTranslationEdit(ed);
  const key = ed.dataset.edit;
  if (!key || !pendingTranslationEdits.has(key)) return;
  if ((e.relatedTarget as HTMLElement | null)?.closest("button[data-move]")) return;
  void saveDraft().then((saved) => {
    if (saved) notify(t("번역안을 저장했습니다"), t("자동 저장"));
  });
});
must("#fullText").addEventListener("click", (e) => {
  const s = (e.target as HTMLElement).closest(".blk");
  if (s instanceof HTMLElement && s.dataset.key) {
    active = s.dataset.key;
    setView("parallel");
    renderRows();
  }
});
must("#fullText").addEventListener("mouseover", (e) => {
  const s = (e.target as HTMLElement).closest(".blk");
  if (s instanceof HTMLElement) {
    const b = shownBlocks().find((x) => x.key === s.dataset.key);
    if (b) setHot(b.anchors);
  }
});
must("#fullText").addEventListener("mouseleave", () => setHot([]));

const cm = must("#ctxmenu");
cm.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button[data-cm]");
  if (!(b instanceof HTMLButtonElement) || b.disabled) return;
  cm.classList.remove("show");
  const i = cmIdx ?? -1;
  const act = b.dataset.cm;
  if (act === "merge") void mergeAt(i);
  else if (act === "split") openSplit(i);
  else if (act === "link") openLink(i);
  else if (act === "source") {
    const blk = shownBlocks()[i];
    if (blk) {
      setHot(blk.anchors);
      setView("source");
    }
  } else if (act === "diff") openDiff();
});

must("#splitCancel").addEventListener("click", () => (must("#dlgSplit") as HTMLDialogElement).close());
must("#splitOk").addEventListener("click", () => {
  void (async () => {
    if (splitIdx === null || !view || editorMutationBusy()) return;
    const ta = must<HTMLTextAreaElement>("#splitText");
    const splitAt = utf16CaretToCodepoint(ta.value, ta.selectionStart);
    const textLength = codepointLength(ta.value);
    if (splitAt <= 0 || splitAt >= textLength) {
      notify(t("나눌 위치에 커서를 두세요"), t("블록 나누기"));
      ta.focus();
      return;
    }
    const b = blocks[splitIdx];
    if (!b) return;
    const selectedBoundary = document.querySelector<HTMLInputElement>('input[name="sa"]:checked');
    const anchorSplitAt = selectedBoundary ? Number(selectedBoundary.value) : undefined;
    if (
      b.anchors.length > 1 &&
      (!Number.isInteger(anchorSplitAt) || (anchorSplitAt ?? 0) < 1 || (anchorSplitAt ?? 0) >= b.anchors.length)
    ) {
      notify(t("앞 블록과 뒤 블록 사이의 앵커 경계를 선택하세요"), t("블록 나누기"));
      return;
    }
    collectEdits();
    if (!(await saveIfDirty())) return;
    const lockVersion = translationLockVersion();
    if (lockVersion === undefined) return;
    const documentNodeId = view.document.id;
    const data = await runEditorViewAction("#splitOk", t("나누기"), () => api.editor.splitBlock({
      documentNodeId,
      blockKey: b.key,
      splitAt,
      ...(anchorSplitAt === undefined ? {} : { anchorSplitAt }),
      expectedLockVersion: lockVersion,
    }));
    if (data) {
      (must("#dlgSplit") as HTMLDialogElement).close();
      applyView(data);
      notify(t("블록을 나눴습니다"), t("블록"));
    }
  })();
});
must("#linkCancel").addEventListener("click", () => (must("#dlgLink") as HTMLDialogElement).close());
must("#linkOk").addEventListener("click", () => {
  void (async () => {
    if (linkIdx === null || editorMutationBusy()) return;
    const sel = $$<HTMLInputElement>('input[name="la"]:checked').map((x) => x.value);
    const b = blocks[linkIdx];
    if (!b) return;
    const previousRelations = new Map(
      b.anchors.map((anchorKey, index) => [anchorKey, b.relationKinds[index] ?? "full"]),
    );
    b.anchors = sel;
    b.relationKinds = sel.map((anchorKey) => previousRelations.get(anchorKey) ?? "full");
    dirty = true;
    (must("#dlgLink") as HTMLDialogElement).close();
    const saved = await saveDraft();
    if (saved) notify(t("앵커 연결을 저장했습니다"), t("앵커 연결"));
  })();
});
must("#btnConfirm").addEventListener("click", openConfirm);
must("#confirmCancel").addEventListener("click", () => (must("#dlgConfirm") as HTMLDialogElement).close());
must("#confirmOk").addEventListener("click", () => {
  void (async () => {
    if (!view || editorMutationBusy()) return;
    collectEdits();
    if (!(await saveIfDirty())) return;
    const lockVersion = translationLockVersion();
    if (lockVersion === undefined) {
      notify(t("편집 중인 번역안의 잠금 버전을 찾을 수 없습니다"), t("확정"));
      return;
    }
    const documentNodeId = view.document.id;
    const data = await runEditorViewAction("#confirmOk", t("확정"), () => api.editor.confirm({
      documentNodeId,
      expectedLockVersion: lockVersion,
    }));
    if (data) {
      (must("#dlgConfirm") as HTMLDialogElement).close();
      applyView(data);
      notify(t("번역안을 확정했습니다"), t("확정"));
    }
  })();
});
must("#btnRevise").addEventListener("click", () => {
  void (async () => {
    if (!view || editorMutationBusy()) return;
    const lockVersion = translationLockVersion();
    if (lockVersion === undefined) return;
    const documentNodeId = view.document.id;
    const data = await runEditorViewAction("#btnRevise", t("새 번역안"), () => api.editor.revise({
      documentNodeId,
      expectedLockVersion: lockVersion,
    }));
    if (data) {
      applyView(data);
      notify(t("새 번역안이 열렸습니다. 확정본은 유지됩니다"), t("새 번역안"));
    }
  })();
});
must("#btnDiff").addEventListener("click", openDiff);
must("#diffClose").addEventListener("click", () => (must("#dlgDiff") as HTMLDialogElement).close());
must("#btnCtxAll").addEventListener("click", openPreparation);
must("#prepClose").addEventListener("click", () => (must("#dlgPrepare") as HTMLDialogElement).close());
must("#prepCloseTop").addEventListener("click", () => (must("#dlgPrepare") as HTMLDialogElement).close());
function queuePreparationSettingsSave(): void {
  if (!appConfig) return;
  const patch = {
    alignment: appConfig.alignment ? { ...appConfig.alignment } : null,
    agentModels: {
      claude: { ...appConfig.agentModels.claude },
      codex: { ...appConfig.agentModels.codex },
      antigravity: { ...appConfig.agentModels.antigravity },
    },
  };
  prepSettingsPending++;
  prepSettingsSaveError = null;
  renderPreparationControls();
  renderAuxiliaryRunControls();
  prepSettingsSaveChain = prepSettingsSaveChain.then(async () => {
    await api.app.setConfig(patch);
    prepSettingsSaveError = null;
  }).catch(error => { prepSettingsSaveError = error; }).finally(() => {
    prepSettingsPending--;
    renderAuxiliaryRunControls();
    renderPreparationControls();
    renderChatModelInfo();
  });
}
must("#prepRetrySettings").addEventListener("click", queuePreparationSettingsSave);
must("#prepModelSettings").addEventListener("change", event => {
  const field = event.target as HTMLSelectElement;
  if (!appConfig || !field.dataset.prepModelSetting || aiStarting || aiRun?.state === "running") return;
  if (!changePrepModelSetting(appConfig, selectedAgentProbe(), selectedPrepAgent(), field.dataset.prepModelSetting, field.value)) return;
  if (prepPreview) renderPreparation();
  else renderPreparationSettings();
  queuePreparationSettingsSave();
});
must("#prepAlignmentSettings").addEventListener("change", event => {
  const field = event.target as HTMLSelectElement;
  if (!appConfig || !field.dataset.alignmentSetting || aiStarting || aiRun?.state === "running") return;
  if (!changeAlignmentSetting(appConfig, agentProbes, field.dataset.alignmentSetting, field.value, selectedPrepAgent())) return;
  renderPreparationSettings();
  queuePreparationSettingsSave();
});
must("#prepAgent").addEventListener("change", () => {
  if (prepPreview) renderPreparation();
  else renderPreparationSettings();
  renderPreparationControls();
});
must("#prepAux").addEventListener("click", (e) => {
  if (aiStarting || aiRun?.state === "running") return;
  const button = (e.target as HTMLElement).closest("button[data-prep-mode]");
  if (!(button instanceof HTMLElement)) return;
  const id = button.closest("[data-prep-id]")?.getAttribute("data-prep-id");
  const mode = button.dataset.prepMode as "auto" | "pin" | "exclude" | undefined;
  if (!id || !mode) return;
  if (prepAuxMode.get(id) === mode && !prepPreviewError) return;
  prepAuxMode.set(id, mode);
  button.closest("[data-prep-id]")?.querySelectorAll<HTMLElement>("[data-prep-mode]").forEach(choice => {
    choice.setAttribute("aria-pressed", String(choice.dataset.prepMode === mode));
  });
  void loadPreparation(true);
});
must("#prepRun").addEventListener("click", () => void startAiTranslation());
must("#prepBack").addEventListener("click", () => {
  prepProgressMode = false;
  renderPreparation();
  renderPreparationControls();
});
must("#prepCancel").addEventListener("click", () => void cancelAiTranslation());
must<HTMLFormElement>("#chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  void startProjectChat();
});
must("#chatInput").addEventListener("keydown", (e) => {
  if (isChatSubmit(e)) {
    e.preventDefault();
    void startProjectChat();
  }
});
mountPopoverSelect(must<HTMLSelectElement>("#chatScope"), "chat-scope-trigger");
must<HTMLSelectElement>("#chatScope").addEventListener("change", () => {
  renderChat();
  renderAuxiliaryRunControls();
  if (view) void refreshChat(view.document.id, selectedChatScope());
});
must("#chatCancel").addEventListener("click", () => void cancelAuxiliaryRun());

const tc = must("#termCard");
document.addEventListener("mouseover", (e) => {
  const t = (e.target as HTMLElement).closest(".term");
  if (!(t instanceof HTMLElement)) {
    if (!(e.target as HTMLElement).closest(".term-card")) tc.classList.remove("show");
    return;
  }
  const d = terms[t.dataset.term ?? ""];
  if (!d) return;
  tc.innerHTML = `<div class="row" style="justify-content:space-between;margin-bottom:5px"><b class="hanmun" style="font-size:15px">${esc(t.dataset.term ?? "")}</b><span class="tag ${d.status === "preferred" ? "tag-ok" : "tag-plain"}">${USAGE_LABELS[d.status]}</span></div><div><b>${esc(d.target)}</b> <span class="muted">· ${esc(d.kind)}</span></div><p class="muted" style="margin-top:5px">${esc(d.note)}</p>`;
  const r = t.getBoundingClientRect();
  const x = Math.min(r.left, innerWidth - 296);
  const y = r.bottom + 8 > innerHeight - 160 ? r.top - 160 : r.bottom + 8;
  tc.style.left = `${x}px`;
  tc.style.top = `${y}px`;
  tc.classList.add("show");
});

function hasUnsavedChanges(): boolean {
  return termReview.hasUnsavedChanges() || sourceDirty || punctuationDirty || dirty || reviewComments.hasUnsavedDraft() || readingStudy.hasUnsavedDraft() || documentMaterials.hasUnsavedDraft();
}

function canLeaveEditor(): boolean {
  if (editorMutationBusy() || workspaceSwitching) {
    notify(t("저장이 끝난 뒤 이동할 수 있습니다"), t("저장 중"));
    return false;
  }
  collectEdits();
  return !hasUnsavedChanges() || window.confirm(t("저장하지 않은 변경이 있습니다. 이 화면을 떠나시겠습니까?"));
}

function clearUnsavedChanges(): void {
  editorAids.beforeView();
  sourceDirty = false;
  punctuationDirty = false;
  punctuationEditingConfirmed = false;
  dirty = false;
  pendingTranslationEdits.clear();
  readingStudy.discard();
  documentMaterials.discard();
}

window.addEventListener("beforeunload", (event) => {
  collectEdits();
  editorAids.flush();
  if (hasUnsavedChanges() || editorMutationBusy()) event.preventDefault();
});

must("#btnHome").addEventListener("click", () => {
  if (!canLeaveEditor()) return;
  clearUnsavedChanges();
  go("home");
});
must("#btnRetryEditor").addEventListener("click", () => {
  const id = readPersistedDoc();
  if (id) void loadEditor(id);
  else go("home");
});

bindSidebar(
  (id) => {
    if (view?.document.id === id) return;
    if (!canLeaveEditor()) return;
    const document = docs.find((item) => item.id === id);
    if (document?.nodeRole === "container") {
      notify(ui`${document.originalTitle || document.title}: 원문·표점안이 없는 목차 폴더입니다`, t("목차 폴더"));
      return;
    }
    void loadEditor(id);
  },
  tree,
);

async function boot(): Promise<void> {
  const [home, config] = await Promise.all([
    api.home.get(),
    api.app.getConfig().catch(() => null),
  ]);
  if (home.ok) {
    docs = home.data.documents;
    agentProbes = home.data.agents;
    setSelfTitle(ui`편집 — ${home.data.project.title}`);
  }
  if (config) {
    appConfig = config;
    must<HTMLSelectElement>("#prepAgent").value = config.agentId;
    must<HTMLSelectElement>("#punctuationAgent").value = config.agentId;
  }
  renderAgentOptions();
  renderPreparationControls();
  renderAuxiliaryRunControls();
  let id = readPersistedDoc();
  if (!id || !docs.some(doc => doc.id === id)) id = findDefaultDoc(docs);
  renderSidebar(tree(), { currentDocId: id });
  try {
    const kn = await api.knowledge.get();
    if (kn.ok) {
      knowledge = kn.data;
      const map: Record<string, TermInfo> = {};
      for (const g of kn.data.glossary) {
        const prev = map[g.sourceTerm];
        if (!prev || g.usageStatus === "preferred") {
          map[g.sourceTerm] = {
            target: g.targetTerm,
            kind: g.termKind,
            status: g.usageStatus,
            note: g.noteMd ?? "",
          };
        }
      }
      terms = map;
    }
  } catch {
    /* optional */
  }
  if (!id) {
    showEditorError(t("열 문서가 없습니다. 프로젝트 홈에서 원문 문서를 만드세요."), t("편집할 문서가 없습니다"));
    return;
  }
  await loadEditor(id);
  void refreshAgentProbes();
  if (store.get("munhae.prepare") === "1") {
    store.set("munhae.prepare", "0");
    openPreparation();
  }
}

window.addEventListener("munhae:config-changed", (event) => {
  const config = (event as CustomEvent<AppConfig>).detail;
  if (!config) return;
  appConfig = config;
  must<HTMLSelectElement>("#prepAgent").value = config.agentId;
  must<HTMLSelectElement>("#punctuationAgent").value = config.agentId;
  if (prepPreview) renderPreparation();
  renderPreparationControls();
  renderAuxiliaryRunControls();
});

const stopAiRunEvents = api.ai.onEvent((run) => {
  if (run.taskKind === "translation") receiveAiRun(run);
  else receiveAuxiliaryRun(run);
});
window.addEventListener("pagehide", () => {
  clearAiPoll();
  clearAuxiliaryPoll();
  stopAiRunEvents();
  clearReferencePreview();
});

await boot();

registerProjectRefresh({
  blocked: () => hasUnsavedChanges() || editorMutationBusy() || workspaceSwitching || blockOrderSaving
    || punctuationApplying || aiStarting || aiRun?.state === "running" || !!auxiliaryStarting || auxiliaryRun?.state === "running"
    || termReview.isBusy() || finalizingAiTerminals.size > 0 || prepSettingsPending > 0 || prepPreviewPending,
  version: () => `${editorLoadSerial}:${editorEditSerial}:${editorViewSerial}`,
  async prepare(change) {
    const id = view?.document.id;
    const home = await api.home.get();
    if (!home.ok) throw new Error(home.error.message);
    if (!id || !home.data.documents.some(doc => doc.id === id)) return () => { location.href = "home.html"; };
    const affectsDocument = change.reason === "resync" || !change.documentIds.length || change.documentIds.includes(id)
      || change.scopes.some(scope => ["terms", "materials", "comments", "project"].includes(scope));
    if (!affectsDocument) return () => { docs = home.data.documents; renderSidebar(tree(), { currentDocId: id }); };
    const [editor, nextKnowledge, suggestion] = await Promise.all([api.editor.get(id), api.knowledge.get(), api.ai.getPunctuationSuggestion(id)]);
    if (!editor.ok) throw new Error(editor.error.message);
    if (!nextKnowledge.ok) throw new Error(nextKnowledge.error.message);
    if (!suggestion.ok) throw new Error(suggestion.error.message);
    const applyTerms = await termReview.prepareRefresh(editor.data);
    return () => {
      const position = editorPosition();
      const previewingSuggestion = punctuationPreviewing;
      docs = home.data.documents; knowledge = nextKnowledge.data;
      const nextTerms: Record<string, TermInfo> = {};
      for (const item of knowledge.glossary) if (!nextTerms[item.sourceTerm] || item.usageStatus === "preferred") {
        nextTerms[item.sourceTerm] = { target: item.targetTerm, kind: item.termKind, status: item.usageStatus, note: item.noteMd ?? "" };
      }
      terms = nextTerms;
      applyView(editor.data);
      punctuationSuggestion = suggestion.data;
      if (previewingSuggestion && suggestion.data && !suggestion.data.applied) showPunctuationSuggestion(true);
      applyTerms();
      restoreEditorPosition(position);
      renderSidebar(tree(), { currentDocId: id });
    };
  },
});

function applyFullTranslationText(text: string, edits?: Array<{ from: number; to: number; text: string }>): void {
  if (!editing() || editorMutationBusy() || !view?.translation?.textLayout) return;
  if (sentenceLinks.some(link => link.groupId)) {
    if (!edits && view.project.storageMode === "local") {
      const field = must<HTMLTextAreaElement>("#fullTranslationInput");
      const result = editGroupedText(translationDraftText, sentenceDrafts, text);
      if (!result) {
        field.value = translationDraftText;
        notify("여러 묶음의 본문을 한 번에 바꾸려면 먼저 묶음을 합치세요.");
        return;
      }
      translationDraftText = result.text; sentenceDrafts = result.sentences;
      for (const id of result.changedIds) {
        const link = sentenceLinks.find(l => l.sentenceId === id);
        if (link) { link.needsReview = true; delete link.reviewedBy; }
      }
      dirty = groupStructureDirty || translationDraftText !== view.translation.textContent;
      editorEditSerial++; editorAids.record("translation-flow");
      renderRows(); renderFull(); renderStrip();
      return;
    }
    if (!edits) { notify("번역 묶음 안에서 편집하세요."); return; }
    const points = Array.from(translationDraftText);
    const changes = edits.map(edit => {
      const sentence = sentenceDrafts.find(sentence => {
        const from = points.slice(0, sentence.from).join("").length;
        const to = points.slice(0, sentence.to).join("").length;
        return edit.from >= from && edit.to <= to;
      });
      return { edit, sentence, from: sentence ? points.slice(0, sentence.from).join("").length : 0 };
    });
    if (changes.some(change => !change.sentence)) { notify("묶음 경계를 넘는 바꾸기는 먼저 묶음을 합친 뒤 실행하세요."); return; }
    for (const { edit, sentence, from } of changes.reverse()) {
      const current = sentenceDrafts.find(item => item.id === sentence!.id)!;
      updateSentenceDraft(current.id, current.text.slice(0, edit.from - from) + edit.text + current.text.slice(edit.to - from));
      const link = sentenceLinks.find(item => item.sentenceId === current.id);
      if (link) { link.needsReview = true; delete link.reviewedBy; }
    }
    editorEditSerial++;
    must<HTMLTextAreaElement>("#fullTranslationInput").value = translationDraftText;
    dirty = groupStructureDirty || translationDraftText !== view.translation.textContent;
    editorAids.record();
    renderRows(); renderFull(); renderStrip();
    return;
  }
  editorEditSerial += 1;
  must<HTMLTextAreaElement>("#fullTranslationInput").value = text;
  translationDraftText = text;
  dirty=text !== view?.translation?.textContent;
  sentenceDrafts=textSentences(text);
  const savedLayout = view?.translation?.textLayout;
  const matches = matchUnchangedTextSentences(trimTextSentences(view.translation.textContent, savedLayout?.sentences ?? []), sentenceDrafts);
  const retainedIds = new Set(matches.values());
  const brokenGroups = new Set(savedLayout?.links.filter(link => link.groupId && !retainedIds.has(link.sentenceId)).map(link => link.groupId));
  sentenceLinks = dirty ? sentenceDrafts.flatMap((sentence) => {
    const previous = savedLayout?.links.find((link) => link.sentenceId === matches.get(sentence.id));
    return previous && !brokenGroups.has(previous.groupId) ? [{ ...previous, sentenceId: sentence.id }] : [];
  }) : (savedLayout?.links ?? []).map((link) => ({ ...link }));
  editorAids.record();
  renderRows();
  renderFull();
  renderStrip();
}
must("#btnSaveFullTranslation").addEventListener("click",()=>void saveDraft());

must("#btnRetryAlignment").addEventListener("click",()=>void (async()=>{
  if(!view?.translation?.textLayout || hasUnsavedChanges() || aiRun?.state==="running") return;
  await prepSettingsSaveChain;
  if (prepSettingsSaveError) { notify("문장 연결 설정을 저장한 뒤 다시 실행하세요."); return; }
  const result=await api.ai.startTranslation({documentNodeId:view.document.id,agentId:selectedPrepAgent(),alignmentVersionId:view.translation.versionId});
  const run=unwrap(result,t("원문 연결"));
  if(run){aiRun=run;renderFull();scheduleAiPoll(run.messageId);}
})());
