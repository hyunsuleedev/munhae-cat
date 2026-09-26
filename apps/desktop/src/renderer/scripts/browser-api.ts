import { t } from "./i18n";
import { IPC_CHANNELS, type IpcChannel, type MunhaeApi } from "../../shared/munhae-api";
import { createBrowserAccountEvents } from "./browser-auth-events";

import { createBrowserProjectEvents } from "./browser-project-events";
const projectEvents = createBrowserProjectEvents();

const BRIDGE_URL = "/__munhae/api";
const accountEvents = createBrowserAccountEvents();

async function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const payload = await response.json() as { value?: T; error?: string };
  if (!response.ok) throw new Error(payload.error ?? t("Electron 브리지에 연결할 수 없습니다."));
  return payload.value as T;
}

export function createBrowserApi(): MunhaeApi {
  return {
    billing: {
      getStatus: () => invoke(IPC_CHANNELS.billingGetStatus),
      openCheckout: () => invoke(IPC_CHANNELS.billingOpenCheckout),
      openPortal: () => invoke(IPC_CHANNELS.billingOpenPortal),
    },
    community: {
      feed: () => invoke(IPC_CHANNELS.communityFeed),
      thread: (postId) => invoke(IPC_CHANNELS.communityThread, postId),
      createPost: (input) => invoke(IPC_CHANNELS.communityCreatePost, input),
      updatePost: (postId, input) => invoke(IPC_CHANNELS.communityUpdatePost, postId, input),
      deletePost: (postId) => invoke(IPC_CHANNELS.communityDeletePost, postId),
      resolvePost: (postId, resolved) => invoke(IPC_CHANNELS.communityResolvePost, postId, resolved),
      addComment: (postId, body) => invoke(IPC_CHANNELS.communityAddComment, postId, body),
      deleteComment: (commentId) => invoke(IPC_CHANNELS.communityDeleteComment, commentId),
      setBookmark: (postId, saved) => invoke(IPC_CHANNELS.communitySetBookmark, postId, saved),
      report: (postId, reason) => invoke(IPC_CHANNELS.communityReport, postId, reason),
      reports: () => invoke(IPC_CHANNELS.communityReports),
      dismissReport: (reportId) => invoke(IPC_CHANNELS.communityDismissReport, reportId),
    },
    dictionary: {
      search: (input) => invoke(IPC_CHANNELS.dictionarySearch, input),
      getStatus: () => invoke(IPC_CHANNELS.dictionaryGetStatus),
      setKey: (input) => invoke(IPC_CHANNELS.dictionarySetKey, input),
    },
    auth: {
      getState: () => invoke(IPC_CHANNELS.authGetState),
      signUp: (input) => invoke(IPC_CHANNELS.authSignUp, input),
      signIn: (input) => invoke(IPC_CHANNELS.authSignIn, input),
      signInWithGoogle: () => invoke(IPC_CHANNELS.authSignInWithGoogle),
      cancelGoogleSignIn: () => invoke(IPC_CHANNELS.authCancelGoogleSignIn),
      signOut: () => invoke(IPC_CHANNELS.authSignOut),
      verifyCode: (input) => invoke(IPC_CHANNELS.authVerifyCode, input),
      resendConfirmation: (email) => invoke(IPC_CHANNELS.authResendConfirmation, email),
      requestPasswordReset: (email) => invoke(IPC_CHANNELS.authRequestPasswordReset, email),
      updatePassword: (input) => invoke(IPC_CHANNELS.authUpdatePassword, input),
      onStateChanged: accountEvents.subscribe,
    },
    app: {
      getVersion: () => invoke(IPC_CHANNELS.appGetVersion),
      getConfig: () => invoke(IPC_CHANNELS.appGetConfig),
      setConfig: (patch) => invoke(IPC_CHANNELS.appSetConfig, patch),
      probeAgents: () => invoke(IPC_CHANNELS.appProbeAgents),
      getLoginInstruction: (agentId) => invoke(IPC_CHANNELS.appGetLoginInstruction, agentId),
      quit: () => invoke(IPC_CHANNELS.appQuit),
      checkUpdates: async () => { throw new Error(t("업데이트 확인은 문해 데스크톱 앱에서 사용할 수 있습니다.")); },
      openExternal: (url) => invoke(IPC_CHANNELS.appOpenExternal, url),
      copyText: (text) => navigator.clipboard.writeText(text),
      openChatSource: (url) => invoke(IPC_CHANNELS.appOpenChatSource, url),
      onCommand: () => () => undefined,
    },
    onlineProjects: {
      sharing: (input) => invoke(IPC_CHANNELS.onlineProjectsSharing, input),
      invitations: () => invoke(IPC_CHANNELS.onlineProjectsInvitations),
      invite: (input) => invoke(IPC_CHANNELS.onlineProjectsInvite, input),
      respond: (input) => invoke(IPC_CHANNELS.onlineProjectsRespond, input),
      cancelInvitation: (input) => invoke(IPC_CHANNELS.onlineProjectsCancelInvitation, input),
      updateMember: (input) => invoke(IPC_CHANNELS.onlineProjectsUpdateMember, input),
      open: (input) => invoke(IPC_CHANNELS.onlineProjectsOpen, input),
      status: () => invoke(IPC_CHANNELS.onlineProjectsStatus),
      sync: () => invoke(IPC_CHANNELS.onlineProjectsSync),
      exportRecovery: (id) => invoke(IPC_CHANNELS.onlineProjectsExportRecovery, id),
      create: (input) => invoke(IPC_CHANNELS.onlineProjectsCreate, input),
      list: () => invoke(IPC_CHANNELS.onlineProjectsList),
      get: (id) => invoke(IPC_CHANNELS.onlineProjectsGet, id),
    },
    project: {
      onChanged: projectEvents.subscribe,
      create: (input) => invoke(IPC_CHANNELS.projectCreate, input),
      open: (packagePath) => invoke(IPC_CHANNELS.projectOpen, packagePath),
      close: () => invoke(IPC_CHANNELS.projectClose),
      getCurrent: () => invoke(IPC_CHANNELS.projectGetCurrent),
      listRecent: () => invoke(IPC_CHANNELS.projectListRecent),
      backup: () => invoke(IPC_CHANNELS.projectBackup),
      concordance: (input) => invoke(IPC_CHANNELS.projectConcordance, input),
    exportReview: (input) => invoke(IPC_CHANNELS.projectExportReview, input),
    exportConfirmed: (input) => invoke(IPC_CHANNELS.projectExportConfirmed, input),
      search: (input) => invoke(IPC_CHANNELS.projectSearch, input),
      createFromPaste: (input) => invoke(IPC_CHANNELS.projectCreateFromPaste, input),
      seedDemo: () => invoke(IPC_CHANNELS.projectSeedDemo),
    },
    home: {
      get: () => invoke(IPC_CHANNELS.homeGet),
      createDocument: (input) => invoke(IPC_CHANNELS.documentCreate, input),
      pickTextFile: () => invoke(IPC_CHANNELS.documentPickText),
      getDocumentMetadata: (documentNodeId) => invoke(IPC_CHANNELS.documentGetMetadata, documentNodeId),
      moveDocument: (input) => invoke(IPC_CHANNELS.documentMove, input),
      updateDocumentMetadata: (input) => invoke(IPC_CHANNELS.documentUpdateMetadata, input),
    },
    editor: {
      get: (documentNodeId) => invoke(IPC_CHANNELS.editorGet, documentNodeId),
      saveSourceDraft: (input) => invoke(IPC_CHANNELS.editorSaveSourceDraft, input),
      confirmSource: (input) => invoke(IPC_CHANNELS.editorConfirmSource, input),
      createPunctuationDraft: (input) => invoke(IPC_CHANNELS.editorCreatePunctuationDraft, input),
      savePunctuationDraft: (input) => invoke(IPC_CHANNELS.editorSavePunctuationDraft, input),
      confirmPunctuation: (input) => invoke(IPC_CHANNELS.editorConfirmPunctuation, input),
      createTranslationDraft: (input) => invoke(IPC_CHANNELS.editorCreateTranslationDraft, input),
      resetTranslationDraft: (input) => invoke(IPC_CHANNELS.editorResetTranslationDraft, input),
      saveDraft: (input) => invoke(IPC_CHANNELS.editorSaveDraft, input),
      confirm: (input) => invoke(IPC_CHANNELS.editorConfirm, input),
      revise: (input) => invoke(IPC_CHANNELS.editorRevise, input),
      mergeBlocks: (input) => invoke(IPC_CHANNELS.editorMergeBlocks, input),
      splitBlock: (input) => invoke(IPC_CHANNELS.editorSplitBlock, input),
      getHistory: (documentNodeId) => invoke(IPC_CHANNELS.editorGetHistory, documentNodeId),
      compareVersions: (input) => invoke(IPC_CHANNELS.editorCompareVersions, input),
      listReviewComments: (documentNodeId) => invoke(IPC_CHANNELS.editorListReviewComments, documentNodeId),
      saveSentenceLink: (input) => invoke(IPC_CHANNELS.editorSaveSentenceLink, input),
      createReviewComment: (input) => invoke(IPC_CHANNELS.editorCreateReviewComment, input),
      updateReviewComment: (input) => invoke(IPC_CHANNELS.editorUpdateReviewComment, input),
      archiveReviewComment: (input) => invoke(IPC_CHANNELS.editorArchiveReviewComment, input),
      listReadingAnnotations: (documentNodeId) => invoke(IPC_CHANNELS.editorListReadingAnnotations, documentNodeId),
      saveReadingAnnotation: (input) => invoke(IPC_CHANNELS.editorSaveReadingAnnotation, input),
      archiveReadingAnnotation: (input) => invoke(IPC_CHANNELS.editorArchiveReadingAnnotation, input),
      attachReference: (documentNodeId) => invoke(IPC_CHANNELS.editorAttachReference, documentNodeId),
      readReference: (documentNodeId, assetId) =>
        invoke(IPC_CHANNELS.editorReadReference, documentNodeId, assetId),
      openReference: (documentNodeId, assetId) =>
        invoke(IPC_CHANNELS.editorOpenReference, documentNodeId, assetId),
    },
    research: {
    startReadingAnalysis: input => invoke(IPC_CHANNELS.researchStartReadingAnalysis, input),
    getReadingAnalysis: id => invoke(IPC_CHANNELS.researchGetReadingAnalysis, id),
    latestReadingAnalysis: input => invoke(IPC_CHANNELS.researchLatestReadingAnalysis, input),
    cancelReadingAnalysis: id => invoke(IPC_CHANNELS.researchCancelReadingAnalysis, id),
    applyReadingAnalysis: input => invoke(IPC_CHANNELS.researchApplyReadingAnalysis, input),
      startMaterialRefinement: input => invoke(IPC_CHANNELS.researchStartMaterialRefinement, input),
      getMaterialRefinement: id => invoke(IPC_CHANNELS.researchGetMaterialRefinement, id),
      cancelMaterialRefinement: id => invoke(IPC_CHANNELS.researchCancelMaterialRefinement, id),
      searchFootnotes: (input) => invoke(IPC_CHANNELS.researchSearchFootnotes, input),
      startFootnoteAnalysis: (input) => invoke(IPC_CHANNELS.researchStartFootnoteAnalysis, input),
      getFootnoteAnalysis: (id) => invoke(IPC_CHANNELS.researchGetFootnoteAnalysis, id),
      cancelFootnoteAnalysis: (id) => invoke(IPC_CHANNELS.researchCancelFootnoteAnalysis, id),
    },
    terms: {
    list: documentId => invoke(IPC_CHANNELS.termsList, documentId),
    delete: input => invoke(IPC_CHANNELS.termsDelete, input),
    save: input => invoke(IPC_CHANNELS.termsSave, input),
    promote: input => invoke(IPC_CHANNELS.termsPromote, input),
    start: (documentId, excludedMaterialIds, glossarySelection) => invoke(IPC_CHANNELS.termsStart, documentId, excludedMaterialIds, glossarySelection),
    getRun: id => invoke(IPC_CHANNELS.termsGetRun, id),
    latestRun: id => invoke(IPC_CHANNELS.termsLatestRun, id),
    cancel: id => invoke(IPC_CHANNELS.termsCancel, id),
  },
  knowledge: {
    getMaterials: (documentNodeId) => invoke(IPC_CHANNELS.knowledgeGetMaterials, documentNodeId),
    setMaterialPreference: (input) => invoke(IPC_CHANNELS.knowledgeSetMaterialPreference, input),
    reuseCommentAsMaterial: (input) => invoke(IPC_CHANNELS.knowledgeReuseCommentAsMaterial, input),
      get: () => invoke(IPC_CHANNELS.knowledgeGet),
      upsertGlossary: (entry) => invoke(IPC_CHANNELS.knowledgeUpsertGlossary, entry),
      createContext: (input) => invoke(IPC_CHANNELS.knowledgeCreateContext, input),
      updateContext: (input) => invoke(IPC_CHANNELS.knowledgeUpdateContext, input),
      setContextEnabled: (input) => invoke(IPC_CHANNELS.knowledgeSetContextEnabled, input),
      setContextPriority: (input) => invoke(IPC_CHANNELS.knowledgeSetContextPriority, input),
      deleteContext: (input) => invoke(IPC_CHANNELS.knowledgeDeleteContext, input),
      createUncertainty: (input) => invoke(IPC_CHANNELS.knowledgeCreateUncertainty, input),
      versionUncertainty: (input) => invoke(IPC_CHANNELS.knowledgeVersionUncertainty, input),
      resolveUncertainty: (input) => invoke(IPC_CHANNELS.knowledgeResolveUncertainty, input),
    },
    context: {
      preview: (input) => invoke(IPC_CHANNELS.contextPreview, input),
    },
    plugins: {
      list: () => invoke(IPC_CHANNELS.pluginsList),
      install: () => invoke(IPC_CHANNELS.pluginsInstall),
      remove: (name) => invoke(IPC_CHANNELS.pluginsRemove, name),
      apply: (name) => invoke(IPC_CHANNELS.pluginsApply, name),
      catalog: () => invoke(IPC_CHANNELS.pluginsCatalog),
      installCatalog: (name) => invoke(IPC_CHANNELS.pluginsInstallCatalog, name),
    },
    ai: {
      startTranslation: (input) => invoke(IPC_CHANNELS.aiStartTranslation, input),
      startChat: (input) => invoke(IPC_CHANNELS.aiStartChat, input),
      startPunctuation: (input) => invoke(IPC_CHANNELS.aiStartPunctuation, input),
    getChat: (input) => invoke(IPC_CHANNELS.aiGetChat, input),
    getPunctuationSuggestion: (documentNodeId) =>
      invoke(IPC_CHANNELS.aiGetPunctuationSuggestion, documentNodeId),
    applyPunctuationSuggestion: (messageId) =>
      invoke(IPC_CHANNELS.aiApplyPunctuationSuggestion, messageId),
      cancel: (messageId) => invoke(IPC_CHANNELS.aiCancelRun, messageId),
      get: (messageId) => invoke(IPC_CHANNELS.aiGetRun, messageId),
      // The HTTP bridge cannot receive Electron push events. Renderer callers also
      // poll `get` while a run is active, so this remains a safe no-op subscription.
      onEvent: () => () => undefined,
    },
  };
}
