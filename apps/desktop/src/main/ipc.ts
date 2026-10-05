import { READING_ANALYSIS_CHANNELS, dispatchReadingAnalysis } from "./reading-analysis-handlers";
import { onlineSaveRequestKey, withOnlineProjectSave } from "./session";
import { latestTermExtraction, startTermExtraction, getTermExtraction, cancelTermExtraction, termReferenceList } from "./term-review";
import { startMaterialRefinement, getMaterialRefinement, cancelMaterialRefinement } from "./material-refinement";
import { translateUi } from "../shared/ui-translations";
import { installApplicationMenu } from "./menu";
import { checkAppUpdates } from "./app-updates";
import { MATERIAL_CHANNELS, dispatchMaterial } from "./translation-materials";
import { parseTermReferenceSelection, parseTermMaterialExclusions, parseConcordanceInput, parseReviewExportInput, parseTranslationExportInput } from "./ipc-validate";
import { exportReviewTranslations, exportTranslationDocument } from "./session";
import { app, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS, type IpcChannel, type IpcResult } from "../shared/munhae-api";
import { probeAgentsCached } from "./agents";
import { searchItkcFootnotes } from "./itkc-footnotes";
import { dictionarySearch, dictionaryGetStatus, dictionarySetKey } from "./dictionary";
import { startFootnoteAnalysis, getFootnoteAnalysis, cancelFootnoteAnalysis } from "./footnote-analysis";
import { AppError, errorCode } from "./errors";
import { redact, log } from "./log";
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
  pickTextFile,
  openProjectInteractive,
  openProjectPathInOs,
  requireRepo,
  setRuntimeSessionRef,
  clearRuntimeSession,
  seedDemo,
  setAppConfig,
} from "./session";
import { getMainWindow } from "./window";
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
import { ONLINE_PROJECT_CHANNELS, dispatchOnlineProject } from "./online-project-handlers";
import { BILLING_CHANNELS, dispatchBilling } from "./billing-handlers";
import { COMMUNITY_CHANNELS, dispatchCommunity } from "./community";
import { PLUGIN_CHANNELS, dispatchPlugin } from "./plugins";
import { MCP_CHANNELS, dispatchMcp } from "./mcp-connect";
import { leaveOnlineWorkspace } from "./session";

const runtimeSessionStore = {
  get: getRuntimeSessionRef,
  set: setRuntimeSessionRef,
  clear: clearRuntimeSession,
};

const ALLOWED_CHANNELS = new Set<string>(Object.values(IPC_CHANNELS));

function assertSender(event: IpcMainInvokeEvent): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    throw new AppError("invalid_sender", "허용되지 않은 호출입니다.");
  }
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
  const redacted = redact(raw);
  return redacted.length > 400 ? `${redacted.slice(0, 400)}…` : redacted;
}

function toIpcError(error: unknown): IpcResult<never> {
  const code = errorCode(error);
  if (code === "internal") {
    log.error("ipc handler failed", { code, name: error instanceof Error ? error.name : "unknown" });
  } else {
    log.warn("ipc rejected", { code });
  }
  return { ok: false, error: { code, message: translateUi(safeMessage(error), getAppConfig().language) } };
}

function handleRaw(channel: IpcChannel, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`channel not allowed: ${channel}`);
  }
  ipcMain.handle(channel, async (event, ...args) => {
    assertSender(event);
    try { return await fn(event, ...args); } catch (error) {
      throw new AppError(errorCode(error), translateUi(safeMessage(error), getAppConfig().language));
    }
  });
}

function handleResult(channel: IpcChannel, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): void {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`channel not allowed: ${channel}`);
  }
  ipcMain.handle(channel, async (event, ...args): Promise<IpcResult<unknown>> => {
    try {
      assertSender(event);
      return { ok: true, data: await withOnlineProjectSave(() => fn(event, ...args), channel.startsWith("munhae:auth:") || new Set<IpcChannel>([IPC_CHANNELS.projectOpen, IPC_CHANNELS.projectClose, IPC_CHANNELS.projectCreate, IPC_CHANNELS.projectCreateFromPaste, IPC_CHANNELS.projectSeedDemo, IPC_CHANNELS.onlineProjectsOpen]).has(channel), onlineSaveRequestKey(channel, args)) };
    } catch (error) {
      return toIpcError(error);
    }
  });
}

export function registerIpcHandlers(): void {
  for (const channel of BILLING_CHANNELS) {
    handleResult(channel, () => dispatchBilling(channel));
  }
  for (const channel of COMMUNITY_CHANNELS) {
    handleResult(channel, (_event, ...args) => dispatchCommunity(channel, args));
  }
  for (const channel of ONLINE_PROJECT_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchOnlineProject(channel, input));
  }
  for (const channel of MATERIAL_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchMaterial(channel, input));
  }
  for (const channel of READING_ANALYSIS_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchReadingAnalysis(channel, input));
  }
  for (const channel of READING_ANNOTATION_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchReadingAnnotation(channel, input));
  }
  for (const channel of PLUGIN_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchPlugin(channel, input));
  }
  for (const channel of MCP_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchMcp(channel, input));
  }
  handleResult(IPC_CHANNELS.dictionarySearch, (_event, input) => dictionarySearch(input));
  handleResult(IPC_CHANNELS.dictionaryGetStatus, () => dictionaryGetStatus());
  handleResult(IPC_CHANNELS.dictionarySetKey, (_event, input) => dictionarySetKey(input));
  handleResult(IPC_CHANNELS.researchSearchFootnotes, (_event, input) => searchItkcFootnotes(input));
  // Term inputs are validated in full by the database layer (content, notes, exact positions, basis).
  handleResult(IPC_CHANNELS.termsDocument, (_event, id) => requireRepo().getDocumentTerms(parseMessageId(id)));
  handleResult(IPC_CHANNELS.termsProject, () => requireRepo().getProjectTerms());
  handleResult(IPC_CHANNELS.termsSentences, (_event, id, documentId) =>
    requireRepo().getTermSentences(parseMessageId(id), documentId == null ? undefined : parseMessageId(documentId)));
  handleResult(IPC_CHANNELS.termsReferences, (_event, id) => termReferenceList(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.termsConfirm, (_event, input) => requireRepo().confirmTerm(input as import("@munhae/db-sqlite").ConfirmTermInput));
  handleResult(IPC_CHANNELS.termsDismiss, (_event, input) => requireRepo().dismissTermCandidate(input as { id: string }));
  handleResult(IPC_CHANNELS.termsUpdate, (_event, input) => requireRepo().updateTerm(input as import("@munhae/db-sqlite").UpdateTermInput));
  handleResult(IPC_CHANNELS.termsUpdateUse, (_event, input) => requireRepo().updateDocumentTerm(input as import("@munhae/db-sqlite").UpdateDocumentTermInput));
  handleResult(IPC_CHANNELS.termsDelete, (_event, input) => requireRepo().deleteDocumentTerm(input as { id: string; expectedLockVersion: number }));
  handleResult(IPC_CHANNELS.termsDeleteProjectTerms, (_event, input) => requireRepo().deleteTerms(input as { terms: Array<{ id: string; expectedLockVersion: number }> }));
  handleResult(IPC_CHANNELS.termsStart, (_event, id, exclusions, referenceSelection) => startTermExtraction(requireRepo(), getAppConfig(), parseMessageId(id), parseTermMaterialExclusions(exclusions), parseTermReferenceSelection(referenceSelection)));
  handleResult(IPC_CHANNELS.termsGetRun, (_event, id) => getTermExtraction(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.termsLatestRun, (_event, id) => latestTermExtraction(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.termsCancel, (_event, id) => cancelTermExtraction(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.researchStartMaterialRefinement, (_event, input) => startMaterialRefinement(requireRepo(), getAppConfig(), input));
  handleResult(IPC_CHANNELS.researchGetMaterialRefinement, (_event, id) => getMaterialRefinement(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.researchCancelMaterialRefinement, (_event, id) => cancelMaterialRefinement(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.researchStartFootnoteAnalysis, (_event, input) => startFootnoteAnalysis(requireRepo(), getAppConfig(), input));
  handleResult(IPC_CHANNELS.researchGetFootnoteAnalysis, (_event, id) => getFootnoteAnalysis(requireRepo(), parseMessageId(id)));
  handleResult(IPC_CHANNELS.researchCancelFootnoteAnalysis, (_event, id) => cancelFootnoteAnalysis(requireRepo(), parseMessageId(id)));
  for (const channel of ACCOUNT_CHANNELS) {
    handleResult(channel, (_event, input) => dispatchAccount(channel, input));
  }
  handleRaw(IPC_CHANNELS.appCheckUpdates, () => { void checkAppUpdates(); });
  handleRaw(IPC_CHANNELS.appGetVersion, () => app.getVersion());
  handleRaw(IPC_CHANNELS.appGetConfig, () => getAppConfig());
  handleRaw(IPC_CHANNELS.appSetConfig, (_event, patch) => {
    const previous = getAppConfig().language;
    const config = setAppConfig(patch);
    if (config.language !== previous) installApplicationMenu(config.language);
    return config;
  });
  handleRaw(IPC_CHANNELS.appProbeAgents, () => probeAgentsCached());
  handleRaw(IPC_CHANNELS.appGetLoginInstruction, (_event, agentId) => {
    return getAgentLoginInstruction(parseAgentId(agentId));
  });
  handleRaw(IPC_CHANNELS.appQuit, () => {
    setImmediate(() => app.quit());
  });
  handleRaw(IPC_CHANNELS.appShowAbout, async () => {
    const options = {
      type: "info" as const,
      title: "Munhae Studio",
      message: `Munhae Studio ${app.getVersion()}`,
    };
    if (process.platform === "linux") {
      const win = getMainWindow();
      if (win) await dialog.showMessageBox(win, options);
      else await dialog.showMessageBox(options);
      return;
    }
    app.showAboutPanel();
  });
  handleRaw(IPC_CHANNELS.appCopyText, (_event, text) => {
    if (typeof text !== "string") throw new AppError("invalid_text", "복사할 텍스트가 올바르지 않습니다.");
    clipboard.writeText(text);
  });
  handleRaw(IPC_CHANNELS.appOpenChatSource, async (_event, url) => {
    if (typeof url !== "string") throw new AppError("invalid_url", "올바른 웹 주소가 아닙니다.");
    await openChatSource(url);
  });
  handleRaw(IPC_CHANNELS.appOpenExternal, async (_event, url) => {
    if (typeof url !== "string") {
      throw new AppError("invalid_url", "https 주소만 열 수 있습니다.");
    }
    await openHttpsExternal(url);
  });
  handleRaw(IPC_CHANNELS.appOpenPath, async (_event, target) => {
    const path = parseOptionalPath(target);
    if (!path) {
      throw new AppError("invalid_path", "경로가 올바르지 않습니다.");
    }
    await openProjectPathInOs(path);
  });

  handleResult(IPC_CHANNELS.projectCreate, async (_event, input) => {
    return createProjectInteractive(parseCreateProjectInput(input));
  });
  handleResult(IPC_CHANNELS.projectOpen, async (_event, packagePath) => {
    return openProjectInteractive(parseOptionalPath(packagePath));
  });
  handleResult(IPC_CHANNELS.projectClose, async () => {
    await leaveOnlineWorkspace();
    closeProject();
  });
  handleRaw(IPC_CHANNELS.projectGetCurrent, () => getCurrentSummary());
  handleRaw(IPC_CHANNELS.projectListRecent, () => listRecent());
  handleResult(IPC_CHANNELS.projectBackup, () => backupProject());
  handleResult(IPC_CHANNELS.projectConcordance, (_event, input) => requireRepo().concordance(parseConcordanceInput(input)));
  handleResult(IPC_CHANNELS.projectExportReview, (_event, input) => exportReviewTranslations(parseReviewExportInput(input)));
  handleResult(IPC_CHANNELS.projectExportTranslation, (_event, input) => exportTranslationDocument(parseTranslationExportInput(input)));
  handleResult(IPC_CHANNELS.projectExportConfirmed, (_event, input) => {
    return exportConfirmedTranslations(parseConfirmedExportInput(input));
  });
  handleResult(IPC_CHANNELS.projectSearch, (_event, input) => {
    return requireRepo().search(parseSearchQueryInput(input));
  });
  handleResult(IPC_CHANNELS.projectCreateFromPaste, async (_event, input) => {
    return createFromPaste(parseCreateFromPasteInput(input));
  });
  handleResult(IPC_CHANNELS.projectSeedDemo, async () => { await leaveOnlineWorkspace(); return seedDemo(); });

  handleResult(IPC_CHANNELS.homeGet, () => getHome());
  handleResult(IPC_CHANNELS.documentCreate, (_event, input) => {
    return requireRepo().createDocument(parseCreateDocumentInput(input));
  });
  handleResult(IPC_CHANNELS.documentPickText, () => pickTextFile());
  handleResult(IPC_CHANNELS.documentGetMetadata, (_event, documentNodeId) => {
    return requireRepo().getDocumentMetadata(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.documentMove, (_event, input) => requireRepo().moveDocument(parseMoveDocumentInput(input)));
  handleResult(IPC_CHANNELS.documentGetDeletion, (_event, documentNodeId) => requireRepo().getDocumentDeletion(parseDocumentNodeId(documentNodeId)));
  handleResult(IPC_CHANNELS.documentDelete, (_event, input) => requireRepo().deleteDocument(parseDeleteDocumentInput(input)));
  handleResult(IPC_CHANNELS.documentUpdateMetadata, (_event, input) => {
    return requireRepo().updateDocumentMetadata(parseUpdateDocumentMetadataInput(input));
  });

  handleResult(IPC_CHANNELS.editorGet, (_event, documentNodeId) => {
    return requireRepo().getEditor(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.editorSaveSourceDraft, (_event, input) => {
    return requireRepo().saveSourceDraft(parseSaveSourceDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorConfirmSource, (_event, input) => {
    return requireRepo().confirmSource(parseConfirmSourceInput(input));
  });
  handleResult(IPC_CHANNELS.editorCreatePunctuationDraft, (_event, input) => {
    return requireRepo().createPunctuationDraftFromConfirmedSource(parseCreatePunctuationDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorSavePunctuationDraft, (_event, input) => {
    return requireRepo().savePunctuationDraft(parseSavePunctuationDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorConfirmPunctuation, (_event, input) => {
    return requireRepo().confirmPunctuation(parseConfirmPunctuationInput(input));
  });
  handleResult(IPC_CHANNELS.editorCreateTranslationDraft, (_event, input) => {
    return requireRepo().createTranslationDraft(parseCreateTranslationDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorResetTranslationDraft, (_event, input) => {
    return requireRepo().resetTranslationDraft(parseResetTranslationDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorSaveDraft, (_event, input) => {
    return requireRepo().saveTranslationDraft(parseSaveDraftInput(input));
  });
  handleResult(IPC_CHANNELS.editorConfirm, (_event, input) => {
    return requireRepo().confirmTranslation(parseConfirmInput(input));
  });
  handleResult(IPC_CHANNELS.editorRevise, (_event, input) => {
    return requireRepo().reviseTranslation(parseReviseTranslationInput(input));
  });
  handleResult(IPC_CHANNELS.editorMergeBlocks, (_event, input) => {
    return requireRepo().mergeBlocks(parseMergeBlocksInput(input));
  });
  handleResult(IPC_CHANNELS.editorSplitBlock, (_event, input) => {
    return requireRepo().splitBlock(parseSplitBlockInput(input));
  });
  handleResult(IPC_CHANNELS.editorGetHistory, (_event, documentNodeId) => {
    return requireRepo().getDocumentHistory(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.editorCompareVersions, (_event, input) => {
    return requireRepo().compareVersions(parseVersionDiffInput(input));
  });
  handleResult(IPC_CHANNELS.editorListReviewComments, (_event, documentNodeId) => {
    return requireRepo().listReviewComments(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.editorSaveSentenceLink, (_event, input) => {
    return requireRepo().saveSentenceLink(parseSaveSentenceLinkInput(input));
  });
  handleResult(IPC_CHANNELS.editorCreateReviewComment, (_event, input) => {
    return requireRepo().createReviewComment(parseCreateReviewCommentInput(input));
  });
  handleResult(IPC_CHANNELS.editorUpdateReviewComment, (_event, input) => {
    return requireRepo().updateReviewComment(parseUpdateReviewCommentInput(input));
  });
  handleResult(IPC_CHANNELS.editorArchiveReviewComment, (_event, input) => {
    return requireRepo().archiveReviewComment(parseArchiveReviewCommentInput(input));
  });
  handleResult(IPC_CHANNELS.editorCreateTranslationNote, (_event, input) => {
    return requireRepo().createTranslationNote(parseCreateTranslationNoteInput(input));
  });
  handleResult(IPC_CHANNELS.editorDeleteTranslationNote, (_event, input) => {
    return requireRepo().deleteTranslationNote(parseDeleteTranslationNoteInput(input));
  });
  handleResult(IPC_CHANNELS.editorUpdateTranslationNote, (_event, input) => {
    return requireRepo().updateTranslationNote(parseUpdateTranslationNoteInput(input));
  });
  handleResult(IPC_CHANNELS.editorAttachReference, (_event, documentNodeId) => {
    return attachReferenceInteractive(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.editorReadReference, (_event, documentNodeId, assetId) => {
    return readReference(parseDocumentNodeId(documentNodeId), parseAssetId(assetId));
  });
  handleResult(IPC_CHANNELS.editorOpenReference, (_event, documentNodeId, assetId) => {
    return openReference(parseDocumentNodeId(documentNodeId), parseAssetId(assetId));
  });

  handleResult(IPC_CHANNELS.knowledgeGet, () => requireRepo().getKnowledge());
  handleResult(IPC_CHANNELS.knowledgeCreateContext, (_event, input) => {
    return requireRepo().createContextItem(parseCreateContextItemInput(input));
  });
  handleResult(IPC_CHANNELS.knowledgeUpdateContext, (_event, input) => {
    return requireRepo().updateContextItem(parseUpdateContextItemInput(input));
  });
  handleResult(IPC_CHANNELS.knowledgeSetContextEnabled, (_event, input) => {
    return requireRepo().setContextItemEnabled(parseSetContextItemEnabledInput(input));
  });
  handleResult(IPC_CHANNELS.knowledgeSetContextPriority, (_event, input) => {
    return requireRepo().setContextItemPriority(parseSetContextItemPriorityInput(input));
  });
  handleResult(IPC_CHANNELS.knowledgeDeleteContext, (_event, input) => {
    return requireRepo().deleteContextItem(parseContextItemCasInput(input));
  });

  handleResult(IPC_CHANNELS.contextPreview, (_event, input) => {
    return requireRepo().previewContext(parseContextPreviewInput(input));
  });
  handleResult(IPC_CHANNELS.aiStartTranslation, (_event, input) => {
    return startTranslationRun(requireRepo(), getAppConfig(), parseStartTranslationInput(input), runtimeSessionStore);
  });
  handleResult(IPC_CHANNELS.aiStartChat, (_event, input) => {
    return startProjectChatRun(requireRepo(), getAppConfig(), parseStartProjectChatInput(input), runtimeSessionStore);
  });
  handleResult(IPC_CHANNELS.aiStartPunctuation, (_event, input) => {
    return startPunctuationSuggestionRun(
      requireRepo(),
      getAppConfig(),
      parseStartPunctuationSuggestionInput(input),
      runtimeSessionStore,
    );
  });
  handleResult(IPC_CHANNELS.aiGetChat, (_event, input) => {
    return requireRepo().getChat(parseGetProjectChatInput(input));
  });
  handleResult(IPC_CHANNELS.aiGetPunctuationSuggestion, (_event, documentNodeId) => {
    return requireRepo().getLatestPunctuationSuggestion(parseDocumentNodeId(documentNodeId));
  });
  handleResult(IPC_CHANNELS.aiApplyPunctuationSuggestion, (_event, messageId) => {
    return requireRepo().applyPunctuationSuggestionRun(parseMessageId(messageId));
  });
  handleResult(IPC_CHANNELS.aiCancelRun, (_event, messageId) => {
    return cancelTranslationRun(parseMessageId(messageId));
  });
  handleResult(IPC_CHANNELS.aiGetRun, (_event, messageId) => {
    return getTranslationRun(parseMessageId(messageId));
  });
}
