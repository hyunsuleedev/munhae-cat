import { READING_ANALYSIS_CHANNELS, dispatchReadingAnalysis } from "./reading-analysis-handlers";
import { onlineSaveRequestKey, withOnlineProjectSave } from "./session";
import { latestTermExtraction, startTermExtraction, getTermExtraction, cancelTermExtraction, termReferenceList } from "./term-review";
import { startMaterialRefinement, getMaterialRefinement, cancelMaterialRefinement } from "./material-refinement";
import { MATERIAL_CHANNELS, dispatchMaterial } from "./translation-materials";
import { parseTermReferenceSelection, parseTermMaterialExclusions, parseConcordanceInput, parseReviewExportInput, parseTranslationExportInput } from "./ipc-validate";
import { exportReviewTranslations, exportTranslationDocument } from "./session";
import { app } from "electron";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { IPC_CHANNELS, type IpcChannel, type IpcResult } from "../shared/munhae-api";
import { probeAgentsCached } from "./agents";
import { searchItkcFootnotes } from "./itkc-footnotes";
import { dictionarySearch, dictionaryGetStatus, dictionarySetKey } from "./dictionary";
import { startFootnoteAnalysis, getFootnoteAnalysis, cancelFootnoteAnalysis } from "./footnote-analysis";
import { errorCode } from "./errors";
import {
  parseArchiveReviewCommentInput,
  parseAssetId,
  parseAgentId,
  parseContextItemCasInput,
  parseConfirmPunctuationInput,
  parseConfirmSourceInput,
  parseConfirmInput,
  parseConfirmedExportInput,
  parseContextPreviewInput,
  parseCreateContextItemInput,
  parseCreateDocumentInput,
  parseCreateFromPasteInput,
  parseCreatePunctuationDraftInput,
  parseCreateProjectInput,
  parseCreateTranslationDraftInput,
  parseCreateReviewCommentInput,
  parseCreateTranslationNoteInput,
  parseDeleteTranslationNoteInput,
  parseUpdateTranslationNoteInput,
  parseDocumentNodeId,
  parseGetProjectChatInput,
  parseMergeBlocksInput,
  parseMessageId,
  parseOptionalPath,
  parseResetTranslationDraftInput,
  parseReviseTranslationInput,
  parseSavePunctuationDraftInput,
  parseSaveSourceDraftInput,
  parseSaveDraftInput,
  parseSaveSentenceLinkInput,
  parseSearchQueryInput,
  parseSplitBlockInput,
  parseStartTranslationInput,
  parseStartProjectChatInput,
  parseStartPunctuationSuggestionInput,
  parseSetContextItemEnabledInput,
  parseSetContextItemPriorityInput,
  parseUpdateContextItemInput,
  parseUpdateReviewCommentInput,
  parseUpdateDocumentMetadataInput,
  parseMoveDocumentInput,
  parseDeleteDocumentInput,
  parseVersionDiffInput,
} from "./ipc-validate";
import { attachReferenceInteractive, openReference, readReference } from "./reference-assets";
import { log, redact } from "./log";
import { openHttpsExternal, openChatSource } from "./security";
import {
  backupProject,
  closeProject,
  createFromPaste,
  createProjectInteractive,
  getAppConfig,
  getRuntimeSessionRef,
  getCurrentSummary,
  getHome,
  exportConfirmedTranslations,
  listRecent,
  openProjectInteractive,
  pickTextFile,
  requireRepo,
  setRuntimeSessionRef,
  clearRuntimeSession,
  seedDemo,
  setAppConfig,
} from "./session";
import {
  cancelTranslationRun,
  getTranslationRun,
  startProjectChatRun,
  startPunctuationSuggestionRun,
  startTranslationRun,
} from "./ai-runs";
import { getAgentLoginInstruction } from "./agent-runtime-client";
import { ACCOUNT_CHANNELS, dispatchAccount } from "./auth-handlers";
import { READING_ANNOTATION_CHANNELS, dispatchReadingAnnotation } from "./reading-annotations";
import { PLUGIN_CHANNELS, dispatchPlugin } from "./plugins";
import { MCP_CHANNELS, dispatchMcp } from "./mcp-connect";
import { ONLINE_PROJECT_CHANNELS, dispatchOnlineProject } from "./online-project-handlers";
import { BILLING_CHANNELS, dispatchBilling } from "./billing-handlers";
import { COMMUNITY_CHANNELS, dispatchCommunity } from "./community";
import { leaveOnlineWorkspace } from "./session";
import { subscribeAccountState, withAccount } from "./auth";
import { serveProjectEvents } from "./project-events";
import { serveBrowserAuthEvents } from "./browser-auth-events";

const runtimeSessionStore = {
  get: getRuntimeSessionRef,
  set: setRuntimeSessionRef,
  clear: clearRuntimeSession,
};

export const BROWSER_BRIDGE_PORT = 17321;
const BODY_LIMIT = 22_000_000;
const ALLOWED_CHANNELS = new Set<IpcChannel>([
  IPC_CHANNELS.dictionarySearch,
  IPC_CHANNELS.dictionaryGetStatus,
  IPC_CHANNELS.dictionarySetKey,
  ...ACCOUNT_CHANNELS,
  ...BILLING_CHANNELS,
  ...COMMUNITY_CHANNELS,
  ...ONLINE_PROJECT_CHANNELS,
  ...READING_ANNOTATION_CHANNELS,
  ...PLUGIN_CHANNELS,
  ...MCP_CHANNELS,
  ...READING_ANALYSIS_CHANNELS,
  ...MATERIAL_CHANNELS,
  IPC_CHANNELS.appGetVersion,
  IPC_CHANNELS.appGetConfig,
  IPC_CHANNELS.appSetConfig,
  IPC_CHANNELS.appProbeAgents,
  IPC_CHANNELS.appGetLoginInstruction,
  IPC_CHANNELS.appQuit,
  IPC_CHANNELS.appOpenExternal,
  IPC_CHANNELS.appOpenChatSource,
  IPC_CHANNELS.projectCreate,
  IPC_CHANNELS.projectOpen,
  IPC_CHANNELS.projectClose,
  IPC_CHANNELS.projectGetCurrent,
  IPC_CHANNELS.projectListRecent,
  IPC_CHANNELS.projectBackup,
  IPC_CHANNELS.projectExportConfirmed,
  IPC_CHANNELS.projectConcordance,
  IPC_CHANNELS.projectExportReview,
  IPC_CHANNELS.projectExportTranslation,
  IPC_CHANNELS.projectSearch,
  IPC_CHANNELS.projectCreateFromPaste,
  IPC_CHANNELS.projectSeedDemo,
  IPC_CHANNELS.homeGet,
  IPC_CHANNELS.documentCreate,
  IPC_CHANNELS.documentPickText,
  IPC_CHANNELS.documentGetMetadata,
  IPC_CHANNELS.documentUpdateMetadata,
  IPC_CHANNELS.documentMove,
  IPC_CHANNELS.documentGetDeletion,
  IPC_CHANNELS.documentDelete,
  IPC_CHANNELS.editorGet,
  IPC_CHANNELS.editorSaveSourceDraft,
  IPC_CHANNELS.editorConfirmSource,
  IPC_CHANNELS.editorCreatePunctuationDraft,
  IPC_CHANNELS.editorSavePunctuationDraft,
  IPC_CHANNELS.editorConfirmPunctuation,
  IPC_CHANNELS.editorCreateTranslationDraft,
  IPC_CHANNELS.editorResetTranslationDraft,
  IPC_CHANNELS.editorSaveDraft,
  IPC_CHANNELS.editorConfirm,
  IPC_CHANNELS.editorRevise,
  IPC_CHANNELS.editorMergeBlocks,
  IPC_CHANNELS.editorSplitBlock,
  IPC_CHANNELS.editorGetHistory,
  IPC_CHANNELS.editorCompareVersions,
  IPC_CHANNELS.editorListReviewComments,
  IPC_CHANNELS.editorSaveSentenceLink,
  IPC_CHANNELS.editorCreateReviewComment,
  IPC_CHANNELS.editorUpdateReviewComment,
  IPC_CHANNELS.editorArchiveReviewComment,
  IPC_CHANNELS.editorCreateTranslationNote,
  IPC_CHANNELS.editorDeleteTranslationNote,
  IPC_CHANNELS.editorUpdateTranslationNote,
  IPC_CHANNELS.editorAttachReference,
  IPC_CHANNELS.editorReadReference,
  IPC_CHANNELS.editorOpenReference,
  IPC_CHANNELS.knowledgeGet,
  IPC_CHANNELS.knowledgeCreateContext,
  IPC_CHANNELS.knowledgeUpdateContext,
  IPC_CHANNELS.knowledgeSetContextEnabled,
  IPC_CHANNELS.knowledgeSetContextPriority,
  IPC_CHANNELS.knowledgeDeleteContext,
  IPC_CHANNELS.contextPreview,
  IPC_CHANNELS.researchSearchFootnotes,
  IPC_CHANNELS.termsDocument, IPC_CHANNELS.termsProject, IPC_CHANNELS.termsSentences, IPC_CHANNELS.termsReferences, IPC_CHANNELS.termsConfirm, IPC_CHANNELS.termsDismiss, IPC_CHANNELS.termsUpdate, IPC_CHANNELS.termsUpdateUse, IPC_CHANNELS.termsDelete, IPC_CHANNELS.termsDeleteProjectTerms, IPC_CHANNELS.termsStart, IPC_CHANNELS.termsGetRun, IPC_CHANNELS.termsLatestRun, IPC_CHANNELS.termsCancel,
  IPC_CHANNELS.researchStartMaterialRefinement,
  IPC_CHANNELS.researchGetMaterialRefinement,
  IPC_CHANNELS.researchCancelMaterialRefinement,
  IPC_CHANNELS.researchStartFootnoteAnalysis,
  IPC_CHANNELS.researchGetFootnoteAnalysis,
  IPC_CHANNELS.researchCancelFootnoteAnalysis,
  IPC_CHANNELS.aiStartTranslation,
  IPC_CHANNELS.aiStartChat,
  IPC_CHANNELS.aiStartPunctuation,
  IPC_CHANNELS.aiGetChat,
  IPC_CHANNELS.aiGetPunctuationSuggestion,
  IPC_CHANNELS.aiApplyPunctuationSuggestion,
  IPC_CHANNELS.aiCancelRun,
  IPC_CHANNELS.aiGetRun,
]);

let server: Server | null = null;
const accountStreams = new Set<() => void>();

function rendererOrigin(): string | null {
  const value = process.env.ELECTRON_RENDERER_URL;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown, origin: string): void {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Origin",
  });
  res.end(JSON.stringify(value));
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  const safe = redact(raw);
  return safe.length > 400 ? `${safe.slice(0, 400)}…` : safe;
}

function toResultError(error: unknown): IpcResult<never> {
  return { ok: false, error: { code: errorCode(error), message: safeMessage(error) } };
}

async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error("요청 본문이 너무 큽니다.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function dispatch(channel: IpcChannel, args: unknown[]): Promise<unknown> {
  const wrap = <T>(fn: () => T | Promise<T>, allowTransition = false) => wrapResult(fn, allowTransition, onlineSaveRequestKey(channel, args));
  if (BILLING_CHANNELS.includes(channel)) return wrap(() => dispatchBilling(channel));
  if (COMMUNITY_CHANNELS.includes(channel)) return wrap(() => dispatchCommunity(channel, args));
  if (ONLINE_PROJECT_CHANNELS.includes(channel)) return wrap(() => dispatchOnlineProject(channel, args[0]), channel === IPC_CHANNELS.onlineProjectsOpen);
  if (READING_ANALYSIS_CHANNELS.includes(channel)) return wrap(() => dispatchReadingAnalysis(channel, args[0]));
  if (READING_ANNOTATION_CHANNELS.includes(channel)) return wrap(() => dispatchReadingAnnotation(channel, args[0]));
  if (PLUGIN_CHANNELS.includes(channel)) return wrap(() => dispatchPlugin(channel, args[0]));
  if (MCP_CHANNELS.includes(channel)) return wrap(() => dispatchMcp(channel, args[0]));
  if (channel === IPC_CHANNELS.dictionarySearch) return wrap(() => dictionarySearch(args[0]));
  if (channel === IPC_CHANNELS.dictionaryGetStatus) return wrap(() => dictionaryGetStatus());
  if (channel === IPC_CHANNELS.dictionarySetKey) return wrap(() => dictionarySetKey(args[0]));
  if (channel === IPC_CHANNELS.researchSearchFootnotes) return wrap(() => searchItkcFootnotes(args[0]));
  if (channel === IPC_CHANNELS.termsDocument) return wrap(() => requireRepo().getDocumentTerms(parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.termsProject) return wrap(() => requireRepo().getProjectTerms());
  if (channel === IPC_CHANNELS.termsSentences) return wrap(() => requireRepo().getTermSentences(parseMessageId(args[0]), args[1] == null ? undefined : parseMessageId(args[1])));
  if (channel === IPC_CHANNELS.termsReferences) return wrap(() => termReferenceList(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.termsConfirm) return wrap(() => requireRepo().confirmTerm(args[0] as import("@munhae/db-sqlite").ConfirmTermInput));
  if (channel === IPC_CHANNELS.termsDismiss) return wrap(() => requireRepo().dismissTermCandidate(args[0] as { id: string }));
  if (channel === IPC_CHANNELS.termsUpdate) return wrap(() => requireRepo().updateTerm(args[0] as import("@munhae/db-sqlite").UpdateTermInput));
  if (channel === IPC_CHANNELS.termsUpdateUse) return wrap(() => requireRepo().updateDocumentTerm(args[0] as import("@munhae/db-sqlite").UpdateDocumentTermInput));
  if (channel === IPC_CHANNELS.termsDelete) return wrap(() => requireRepo().deleteDocumentTerm(args[0] as { id: string; expectedLockVersion: number }));
  if (channel === IPC_CHANNELS.termsDeleteProjectTerms) return wrap(() => requireRepo().deleteTerms(args[0] as { terms: Array<{ id: string; expectedLockVersion: number }> }));
  if (channel === IPC_CHANNELS.termsStart) return wrap(() => startTermExtraction(requireRepo(), getAppConfig(), parseMessageId(args[0]), parseTermMaterialExclusions(args[1]), parseTermReferenceSelection(args[2])));
  if (channel === IPC_CHANNELS.termsGetRun) return wrap(() => getTermExtraction(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.termsLatestRun) return wrap(() => latestTermExtraction(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.termsCancel) return wrap(() => cancelTermExtraction(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.researchStartMaterialRefinement) return wrap(() => startMaterialRefinement(requireRepo(), getAppConfig(), args[0]));
  if (channel === IPC_CHANNELS.researchGetMaterialRefinement) return wrap(() => getMaterialRefinement(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.researchCancelMaterialRefinement) return wrap(() => cancelMaterialRefinement(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.researchStartFootnoteAnalysis) return wrap(() => startFootnoteAnalysis(requireRepo(), getAppConfig(), args[0]));
  if (channel === IPC_CHANNELS.researchGetFootnoteAnalysis) return wrap(() => getFootnoteAnalysis(requireRepo(), parseMessageId(args[0])));
  if (channel === IPC_CHANNELS.researchCancelFootnoteAnalysis) return wrap(() => cancelFootnoteAnalysis(requireRepo(), parseMessageId(args[0])));
  if (ACCOUNT_CHANNELS.includes(channel)) return wrap(() => dispatchAccount(channel, args[0]), true);
  if (MATERIAL_CHANNELS.includes(channel)) return wrap(() => dispatchMaterial(channel, args[0]));
  switch (channel) {
    case IPC_CHANNELS.appGetVersion: return app.getVersion();
    case IPC_CHANNELS.appGetConfig: return getAppConfig();
    case IPC_CHANNELS.appSetConfig: return setAppConfig(args[0]);
    case IPC_CHANNELS.appProbeAgents: return probeAgentsCached();
    case IPC_CHANNELS.appGetLoginInstruction: return getAgentLoginInstruction(parseAgentId(args[0]));
    case IPC_CHANNELS.appQuit:
      setImmediate(() => app.quit());
      return undefined;
    case IPC_CHANNELS.appOpenChatSource:
      if (typeof args[0] !== "string") throw new Error("올바른 웹 주소가 아닙니다.");
      return openChatSource(args[0]);
    case IPC_CHANNELS.appOpenExternal:
      if (typeof args[0] !== "string") throw new Error("https 주소만 열 수 있습니다.");
      return openHttpsExternal(args[0]);
    case IPC_CHANNELS.projectGetCurrent: return getCurrentSummary();
    case IPC_CHANNELS.projectListRecent: return listRecent();
    case IPC_CHANNELS.projectCreate: return wrap(() => createProjectInteractive(parseCreateProjectInput(args[0])), true);
    case IPC_CHANNELS.projectOpen: return wrap(() => openProjectInteractive(parseOptionalPath(args[0])), true);
    case IPC_CHANNELS.projectClose: return wrap(async () => { await leaveOnlineWorkspace(); closeProject(); }, true);
    case IPC_CHANNELS.projectBackup: return wrap(() => backupProject());
    case IPC_CHANNELS.projectConcordance:
      return wrap(() => requireRepo().concordance(parseConcordanceInput(args[0])));
    case IPC_CHANNELS.projectExportReview:
      return wrap(() => exportReviewTranslations(parseReviewExportInput(args[0])));
    case IPC_CHANNELS.projectExportTranslation:
      return wrap(() => exportTranslationDocument(parseTranslationExportInput(args[0])));
    case IPC_CHANNELS.projectExportConfirmed:
      return wrap(() => exportConfirmedTranslations(parseConfirmedExportInput(args[0])));
    case IPC_CHANNELS.projectSearch:
      return wrap(() => requireRepo().search(parseSearchQueryInput(args[0])));
    case IPC_CHANNELS.projectCreateFromPaste: return wrap(() => createFromPaste(parseCreateFromPasteInput(args[0])), true);
    case IPC_CHANNELS.projectSeedDemo: return wrap(async () => { await leaveOnlineWorkspace(); return seedDemo(); }, true);
    case IPC_CHANNELS.homeGet: return wrap(() => getHome());
    case IPC_CHANNELS.documentCreate: return wrap(() => requireRepo().createDocument(parseCreateDocumentInput(args[0])));
    case IPC_CHANNELS.documentPickText: return wrap(() => pickTextFile());
    case IPC_CHANNELS.documentGetMetadata:
      return wrap(() => requireRepo().getDocumentMetadata(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.documentMove: return wrap(() => requireRepo().moveDocument(parseMoveDocumentInput(args[0])));
    case IPC_CHANNELS.documentGetDeletion: return wrap(() => requireRepo().getDocumentDeletion(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.documentDelete: return wrap(() => requireRepo().deleteDocument(parseDeleteDocumentInput(args[0])));
    case IPC_CHANNELS.documentUpdateMetadata:
      return wrap(() => requireRepo().updateDocumentMetadata(parseUpdateDocumentMetadataInput(args[0])));
    case IPC_CHANNELS.editorGet: return wrap(() => requireRepo().getEditor(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.editorSaveSourceDraft:
      return wrap(() => requireRepo().saveSourceDraft(parseSaveSourceDraftInput(args[0])));
    case IPC_CHANNELS.editorConfirmSource:
      return wrap(() => requireRepo().confirmSource(parseConfirmSourceInput(args[0])));
    case IPC_CHANNELS.editorCreatePunctuationDraft:
      return wrap(() => requireRepo().createPunctuationDraftFromConfirmedSource(parseCreatePunctuationDraftInput(args[0])));
    case IPC_CHANNELS.editorSavePunctuationDraft:
      return wrap(() => requireRepo().savePunctuationDraft(parseSavePunctuationDraftInput(args[0])));
    case IPC_CHANNELS.editorConfirmPunctuation:
      return wrap(() => requireRepo().confirmPunctuation(parseConfirmPunctuationInput(args[0])));
    case IPC_CHANNELS.editorCreateTranslationDraft:
      return wrap(() => requireRepo().createTranslationDraft(parseCreateTranslationDraftInput(args[0])));
    case IPC_CHANNELS.editorResetTranslationDraft:
      return wrap(() => requireRepo().resetTranslationDraft(parseResetTranslationDraftInput(args[0])));
    case IPC_CHANNELS.editorSaveDraft: return wrap(() => requireRepo().saveTranslationDraft(parseSaveDraftInput(args[0])));
    case IPC_CHANNELS.editorConfirm: return wrap(() => requireRepo().confirmTranslation(parseConfirmInput(args[0])));
    case IPC_CHANNELS.editorRevise:
      return wrap(() => requireRepo().reviseTranslation(parseReviseTranslationInput(args[0])));
    case IPC_CHANNELS.editorMergeBlocks: return wrap(() => requireRepo().mergeBlocks(parseMergeBlocksInput(args[0])));
    case IPC_CHANNELS.editorSplitBlock: return wrap(() => requireRepo().splitBlock(parseSplitBlockInput(args[0])));
    case IPC_CHANNELS.editorGetHistory:
      return wrap(() => requireRepo().getDocumentHistory(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.editorCompareVersions:
      return wrap(() => requireRepo().compareVersions(parseVersionDiffInput(args[0])));
    case IPC_CHANNELS.editorListReviewComments:
      return wrap(() => requireRepo().listReviewComments(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.editorSaveSentenceLink:
      return wrap(() => requireRepo().saveSentenceLink(parseSaveSentenceLinkInput(args[0])));
    case IPC_CHANNELS.editorCreateReviewComment:
      return wrap(() => requireRepo().createReviewComment(parseCreateReviewCommentInput(args[0])));
    case IPC_CHANNELS.editorUpdateReviewComment:
      return wrap(() => requireRepo().updateReviewComment(parseUpdateReviewCommentInput(args[0])));
    case IPC_CHANNELS.editorArchiveReviewComment:
      return wrap(() => requireRepo().archiveReviewComment(parseArchiveReviewCommentInput(args[0])));
    case IPC_CHANNELS.editorCreateTranslationNote:
      return wrap(() => requireRepo().createTranslationNote(parseCreateTranslationNoteInput(args[0])));
    case IPC_CHANNELS.editorDeleteTranslationNote:
      return wrap(() => requireRepo().deleteTranslationNote(parseDeleteTranslationNoteInput(args[0])));
    case IPC_CHANNELS.editorUpdateTranslationNote:
      return wrap(() => requireRepo().updateTranslationNote(parseUpdateTranslationNoteInput(args[0])));
    case IPC_CHANNELS.editorAttachReference:
      return wrap(() => attachReferenceInteractive(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.editorReadReference:
      return wrap(() => readReference(parseDocumentNodeId(args[0]), parseAssetId(args[1])));
    case IPC_CHANNELS.editorOpenReference:
      return wrap(() => openReference(parseDocumentNodeId(args[0]), parseAssetId(args[1])));
    case IPC_CHANNELS.knowledgeGet: return wrap(() => requireRepo().getKnowledge());
    case IPC_CHANNELS.knowledgeCreateContext:
      return wrap(() => requireRepo().createContextItem(parseCreateContextItemInput(args[0])));
    case IPC_CHANNELS.knowledgeUpdateContext:
      return wrap(() => requireRepo().updateContextItem(parseUpdateContextItemInput(args[0])));
    case IPC_CHANNELS.knowledgeSetContextEnabled:
      return wrap(() => requireRepo().setContextItemEnabled(parseSetContextItemEnabledInput(args[0])));
    case IPC_CHANNELS.knowledgeSetContextPriority:
      return wrap(() => requireRepo().setContextItemPriority(parseSetContextItemPriorityInput(args[0])));
    case IPC_CHANNELS.knowledgeDeleteContext:
      return wrap(() => requireRepo().deleteContextItem(parseContextItemCasInput(args[0])));
    case IPC_CHANNELS.contextPreview:
      return wrap(() => requireRepo().previewContext(parseContextPreviewInput(args[0])));
    case IPC_CHANNELS.aiStartTranslation:
      return wrap(() => startTranslationRun(
        requireRepo(),
        getAppConfig(),
        parseStartTranslationInput(args[0]),
        runtimeSessionStore,
      ));
    case IPC_CHANNELS.aiStartChat:
      return wrap(() => startProjectChatRun(
        requireRepo(),
        getAppConfig(),
        parseStartProjectChatInput(args[0]),
        runtimeSessionStore,
      ));
    case IPC_CHANNELS.aiStartPunctuation:
      return wrap(() => startPunctuationSuggestionRun(
        requireRepo(),
        getAppConfig(),
        parseStartPunctuationSuggestionInput(args[0]),
        runtimeSessionStore,
      ));
    case IPC_CHANNELS.aiGetChat:
      return wrap(() => requireRepo().getChat(parseGetProjectChatInput(args[0])));
    case IPC_CHANNELS.aiGetPunctuationSuggestion:
      return wrap(() => requireRepo().getLatestPunctuationSuggestion(parseDocumentNodeId(args[0])));
    case IPC_CHANNELS.aiApplyPunctuationSuggestion:
      return wrap(() => requireRepo().applyPunctuationSuggestionRun(parseMessageId(args[0])));
    case IPC_CHANNELS.aiCancelRun:
      return wrap(() => cancelTranslationRun(parseMessageId(args[0])));
    case IPC_CHANNELS.aiGetRun:
      return wrap(() => getTranslationRun(parseMessageId(args[0])));
    default: throw new Error("허용되지 않은 호출입니다.");
  }
}

async function wrapResult<T>(fn: () => T | Promise<T>, allowTransition = false, requestKey?: string): Promise<IpcResult<T>> {
  try {
    return { ok: true, data: await withOnlineProjectSave(fn, allowTransition, requestKey) };
  } catch (error) {
    log.warn("browser bridge rejected", { code: errorCode(error) });
    return toResultError(error);
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, origin: string): Promise<void> {
  const requestOrigin = req.headers.origin;
  const host = req.headers.host;
  if (requestOrigin !== origin || (host !== `127.0.0.1:${BROWSER_BRIDGE_PORT}` && host !== `localhost:${BROWSER_BRIDGE_PORT}`)) {
    writeJson(res, 403, { error: "forbidden" }, origin);
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    });
    res.end();
    return;
  }
  if (req.method !== "POST" || (req.url !== "/api" && req.url !== "/auth-events" && req.url !== "/project-events")) {
    writeJson(res, 404, { error: "not_found" }, origin);
    return;
  }
  try {
    if (req.url === "/auth-events" || req.url === "/project-events") {
      await readBody(req, 1_024);
      if (accountStreams.size >= 64) {
        writeJson(res, 503, { error: "too_many_subscriptions" }, origin);
        return;
      }
      let closed = false;
      let close = () => undefined as void;
      close = req.url === "/project-events"
        ? serveProjectEvents(res, origin, () => { closed = true; accountStreams.delete(close); })
        : serveBrowserAuthEvents(res, origin, {
        subscribe: subscribeAccountState,
        getState: () => withAccount((account) => account.getState()),
      }, () => { closed = true; accountStreams.delete(close); });
      if (!closed) accountStreams.add(close);
      return;
    }
    const body = await readBody(req) as { channel?: unknown; args?: unknown };
    if (typeof body.channel !== "string" || !ALLOWED_CHANNELS.has(body.channel as IpcChannel)) {
      throw new Error("허용되지 않은 호출입니다.");
    }
    const args = Array.isArray(body.args) ? body.args : [];
    writeJson(res, 200, { value: await dispatch(body.channel as IpcChannel, args) }, origin);
  } catch (error) {
    log.warn("browser bridge request failed", { code: errorCode(error) });
    writeJson(res, 400, { error: safeMessage(error) }, origin);
  }
}

export function startBrowserBridge(): void {
  if (server) return;
  const origin = rendererOrigin();
  if (!origin) return;
  const next = createServer((req, res) => void handle(req, res, origin));
  next.on("error", (error) => log.error("browser bridge failed", { code: errorCode(error) }));
  next.listen(BROWSER_BRIDGE_PORT, "127.0.0.1", () => {
    server = next;
    log.info("browser bridge ready", { port: BROWSER_BRIDGE_PORT });
  });
}

export function stopBrowserBridge(): void {
  for (const close of [...accountStreams]) close();
  const active = server;
  server = null;
  active?.close();
}
