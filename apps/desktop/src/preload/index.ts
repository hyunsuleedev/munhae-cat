/// <reference path="./index.d.ts" />

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type MunhaeApi } from "../shared/munhae-api";
import { STARTUP_CHANNELS, type StartupApi } from "../shared/startup-api";

const api = {
  billing: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.billingGetStatus),
    openCheckout: () => ipcRenderer.invoke(IPC_CHANNELS.billingOpenCheckout),
    openPortal: () => ipcRenderer.invoke(IPC_CHANNELS.billingOpenPortal),
  },
  community: {
    feed: () => ipcRenderer.invoke(IPC_CHANNELS.communityFeed),
    thread: (postId) => ipcRenderer.invoke(IPC_CHANNELS.communityThread, postId),
    createPost: (input) => ipcRenderer.invoke(IPC_CHANNELS.communityCreatePost, input),
    updatePost: (postId, input) => ipcRenderer.invoke(IPC_CHANNELS.communityUpdatePost, postId, input),
    deletePost: (postId) => ipcRenderer.invoke(IPC_CHANNELS.communityDeletePost, postId),
    resolvePost: (postId, resolved) => ipcRenderer.invoke(IPC_CHANNELS.communityResolvePost, postId, resolved),
    addComment: (postId, body) => ipcRenderer.invoke(IPC_CHANNELS.communityAddComment, postId, body),
    deleteComment: (commentId) => ipcRenderer.invoke(IPC_CHANNELS.communityDeleteComment, commentId),
    setBookmark: (postId, saved) => ipcRenderer.invoke(IPC_CHANNELS.communitySetBookmark, postId, saved),
    report: (postId, reason) => ipcRenderer.invoke(IPC_CHANNELS.communityReport, postId, reason),
    reports: () => ipcRenderer.invoke(IPC_CHANNELS.communityReports),
    dismissReport: (reportId) => ipcRenderer.invoke(IPC_CHANNELS.communityDismissReport, reportId),
  },
  dictionary: {
    search: (input) => ipcRenderer.invoke(IPC_CHANNELS.dictionarySearch, input),
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.dictionaryGetStatus),
    setKey: (input) => ipcRenderer.invoke(IPC_CHANNELS.dictionarySetKey, input),
  },
  auth: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.authGetState),
    signUp: (input) => ipcRenderer.invoke(IPC_CHANNELS.authSignUp, input),
    signIn: (input) => ipcRenderer.invoke(IPC_CHANNELS.authSignIn, input),
    signInWithGoogle: () => ipcRenderer.invoke(IPC_CHANNELS.authSignInWithGoogle),
    cancelGoogleSignIn: () => ipcRenderer.invoke(IPC_CHANNELS.authCancelGoogleSignIn),
    signOut: () => ipcRenderer.invoke(IPC_CHANNELS.authSignOut),
    verifyCode: (input) => ipcRenderer.invoke(IPC_CHANNELS.authVerifyCode, input),
    resendConfirmation: (email) => ipcRenderer.invoke(IPC_CHANNELS.authResendConfirmation, email),
    requestPasswordReset: (email) => ipcRenderer.invoke(IPC_CHANNELS.authRequestPasswordReset, email),
    updatePassword: (input) => ipcRenderer.invoke(IPC_CHANNELS.authUpdatePassword, input),
    onStateChanged: (handler) => {
      const listener = (_event: unknown, state: Parameters<typeof handler>[0]) => handler(state);
      ipcRenderer.on(IPC_CHANNELS.authStateChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.authStateChanged, listener);
    },
  },
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.appGetConfig),
    setConfig: (patch) => ipcRenderer.invoke(IPC_CHANNELS.appSetConfig, patch),
    probeAgents: () => ipcRenderer.invoke(IPC_CHANNELS.appProbeAgents),
    getLoginInstruction: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.appGetLoginInstruction, agentId),
    quit: () => ipcRenderer.invoke(IPC_CHANNELS.appQuit),
    checkUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.appCheckUpdates),
    openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.appOpenExternal, url),
    copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.appCopyText, text),
    openChatSource: (url) => ipcRenderer.invoke(IPC_CHANNELS.appOpenChatSource, url),
    onCommand: (handler) => {
      const listen = (_event: unknown, id: unknown) => {
        if (typeof id === "string") handler(id);
      };
      ipcRenderer.on(IPC_CHANNELS.menuCommand, listen);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.menuCommand, listen);
      };
    },
  },
  onlineProjects: {
      sharing: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsSharing, input),
      invitations: () => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsInvitations),
      invite: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsInvite, input),
      respond: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsRespond, input),
      cancelInvitation: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsCancelInvitation, input),
      updateMember: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsUpdateMember, input),
    open: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsOpen, input),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsStatus),
    sync: () => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsSync),
    exportRecovery: (id) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsExportRecovery, id),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsCreate, input),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsList),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.onlineProjectsGet, id),
  },
  project: {
    onChanged: (handler) => {
      const listener = (_event: unknown, change: Parameters<typeof handler>[0]) => handler(change);
      ipcRenderer.on(IPC_CHANNELS.projectChanged, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.projectChanged, listener);
    },
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectCreate, input),
    open: (packagePath) => ipcRenderer.invoke(IPC_CHANNELS.projectOpen, packagePath),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.projectClose),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.projectGetCurrent),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.projectListRecent),
    backup: () => ipcRenderer.invoke(IPC_CHANNELS.projectBackup),
    concordance: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectConcordance, input),
    exportReview: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectExportReview, input),
    exportTranslation: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectExportTranslation, input),
    exportConfirmed: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectExportConfirmed, input),
    search: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectSearch, input),
    createFromPaste: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectCreateFromPaste, input),
    seedDemo: () => ipcRenderer.invoke(IPC_CHANNELS.projectSeedDemo),
  },
  home: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.homeGet),
    createDocument: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentCreate, input),
    pickTextFile: () => ipcRenderer.invoke(IPC_CHANNELS.documentPickText),
    getDocumentMetadata: (documentNodeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.documentGetMetadata, documentNodeId),
    moveDocument: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentMove, input),
    getDocumentDeletion: (documentNodeId) => ipcRenderer.invoke(IPC_CHANNELS.documentGetDeletion, documentNodeId),
    deleteDocument: (input) => ipcRenderer.invoke(IPC_CHANNELS.documentDelete, input),
    updateDocumentMetadata: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.documentUpdateMetadata, input),
  },
  editor: {
    get: (documentNodeId) => ipcRenderer.invoke(IPC_CHANNELS.editorGet, documentNodeId),
    saveSourceDraft: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSaveSourceDraft, input),
    confirmSource: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorConfirmSource, input),
    createPunctuationDraft: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorCreatePunctuationDraft, input),
    savePunctuationDraft: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorSavePunctuationDraft, input),
    confirmPunctuation: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorConfirmPunctuation, input),
    createTranslationDraft: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorCreateTranslationDraft, input),
    resetTranslationDraft: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorResetTranslationDraft, input),
    saveDraft: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSaveDraft, input),
    confirm: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorConfirm, input),
    revise: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorRevise, input),
    mergeBlocks: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorMergeBlocks, input),
    splitBlock: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSplitBlock, input),
    getHistory: (documentNodeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorGetHistory, documentNodeId),
    compareVersions: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorCompareVersions, input),
    listReviewComments: (documentNodeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorListReviewComments, documentNodeId),
    createReviewComment: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorCreateReviewComment, input),
    saveSentenceLink: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSaveSentenceLink, input),
    updateReviewComment: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorUpdateReviewComment, input),
    archiveReviewComment: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorArchiveReviewComment, input),
    createTranslationNote: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorCreateTranslationNote, input),
    deleteTranslationNote: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorDeleteTranslationNote, input),
    updateTranslationNote: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorUpdateTranslationNote, input),
    listReadingAnnotations: (documentNodeId) => ipcRenderer.invoke(IPC_CHANNELS.editorListReadingAnnotations, documentNodeId),
    saveReadingAnnotation: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorSaveReadingAnnotation, input),
    archiveReadingAnnotation: (input) => ipcRenderer.invoke(IPC_CHANNELS.editorArchiveReadingAnnotation, input),
    attachReference: (documentNodeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorAttachReference, documentNodeId),
    readReference: (documentNodeId, assetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorReadReference, documentNodeId, assetId),
    openReference: (documentNodeId, assetId) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorOpenReference, documentNodeId, assetId),
  },
  research: {
    startReadingAnalysis: input => ipcRenderer.invoke(IPC_CHANNELS.researchStartReadingAnalysis, input),
    getReadingAnalysis: id => ipcRenderer.invoke(IPC_CHANNELS.researchGetReadingAnalysis, id),
    latestReadingAnalysis: input => ipcRenderer.invoke(IPC_CHANNELS.researchLatestReadingAnalysis, input),
    cancelReadingAnalysis: id => ipcRenderer.invoke(IPC_CHANNELS.researchCancelReadingAnalysis, id),
    applyReadingAnalysis: input => ipcRenderer.invoke(IPC_CHANNELS.researchApplyReadingAnalysis, input),
      startMaterialRefinement: input => ipcRenderer.invoke(IPC_CHANNELS.researchStartMaterialRefinement, input),
      getMaterialRefinement: id => ipcRenderer.invoke(IPC_CHANNELS.researchGetMaterialRefinement, id),
      cancelMaterialRefinement: id => ipcRenderer.invoke(IPC_CHANNELS.researchCancelMaterialRefinement, id),
    searchFootnotes: (input) => ipcRenderer.invoke(IPC_CHANNELS.researchSearchFootnotes, input),
    startFootnoteAnalysis: (input) => ipcRenderer.invoke(IPC_CHANNELS.researchStartFootnoteAnalysis, input),
    getFootnoteAnalysis: (id) => ipcRenderer.invoke(IPC_CHANNELS.researchGetFootnoteAnalysis, id),
    cancelFootnoteAnalysis: (id) => ipcRenderer.invoke(IPC_CHANNELS.researchCancelFootnoteAnalysis, id),
  },
  terms: {
    document: documentId => ipcRenderer.invoke(IPC_CHANNELS.termsDocument, documentId),
    project: () => ipcRenderer.invoke(IPC_CHANNELS.termsProject),
    sentences: (termId, documentId) => ipcRenderer.invoke(IPC_CHANNELS.termsSentences, termId, documentId),
    references: documentId => ipcRenderer.invoke(IPC_CHANNELS.termsReferences, documentId),
    confirm: input => ipcRenderer.invoke(IPC_CHANNELS.termsConfirm, input),
    dismiss: input => ipcRenderer.invoke(IPC_CHANNELS.termsDismiss, input),
    update: input => ipcRenderer.invoke(IPC_CHANNELS.termsUpdate, input),
    updateUse: input => ipcRenderer.invoke(IPC_CHANNELS.termsUpdateUse, input),
    delete: input => ipcRenderer.invoke(IPC_CHANNELS.termsDelete, input),
    deleteProjectTerms: input => ipcRenderer.invoke(IPC_CHANNELS.termsDeleteProjectTerms, input),
    start: (documentId, excludedMaterialIds, referenceSelection) => ipcRenderer.invoke(IPC_CHANNELS.termsStart, documentId, excludedMaterialIds, referenceSelection),
    getRun: id => ipcRenderer.invoke(IPC_CHANNELS.termsGetRun, id),
    latestRun: id => ipcRenderer.invoke(IPC_CHANNELS.termsLatestRun, id),
    cancel: id => ipcRenderer.invoke(IPC_CHANNELS.termsCancel, id),
  },
  knowledge: {
    getMaterials: (documentNodeId) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGetMaterials, documentNodeId),
    setMaterialPreference: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSetMaterialPreference, input),
    reuseCommentAsMaterial: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeReuseCommentAsMaterial, input),
    get: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGet),
    createContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeCreateContext, input),
    updateContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeUpdateContext, input),
    setContextEnabled: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSetContextEnabled, input),
    setContextPriority: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSetContextPriority, input),
    deleteContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeDeleteContext, input),
  },
  context: {
    preview: (input) => ipcRenderer.invoke(IPC_CHANNELS.contextPreview, input),
  },
  plugins: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.pluginsList),
    install: () => ipcRenderer.invoke(IPC_CHANNELS.pluginsInstall),
    remove: (name) => ipcRenderer.invoke(IPC_CHANNELS.pluginsRemove, name),
    apply: (name) => ipcRenderer.invoke(IPC_CHANNELS.pluginsApply, name),
    catalog: () => ipcRenderer.invoke(IPC_CHANNELS.pluginsCatalog),
    installCatalog: (name) => ipcRenderer.invoke(IPC_CHANNELS.pluginsInstallCatalog, name),
  },
  mcp: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.mcpStatus),
    connect: (client) => ipcRenderer.invoke(IPC_CHANNELS.mcpConnect, client),
    disconnect: (client) => ipcRenderer.invoke(IPC_CHANNELS.mcpDisconnect, client),
    undo: (changeId) => ipcRenderer.invoke(IPC_CHANNELS.mcpUndo, changeId),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.mcpList),
    reportEditing: (documentId) => ipcRenderer.invoke(IPC_CHANNELS.mcpReportEditing, documentId),
    onChanged: (handler) => {
      const listen = (_event: unknown, change: unknown) => {
        if (change && typeof change === "object") handler(change as Parameters<typeof handler>[0]);
      };
      ipcRenderer.on(IPC_CHANNELS.mcpChanged, listen);
      return () => { ipcRenderer.removeListener(IPC_CHANNELS.mcpChanged, listen); };
    },
  },
  ai: {
    startTranslation: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiStartTranslation, input),
    startChat: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiStartChat, input),
    startPunctuation: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiStartPunctuation, input),
    getChat: (input) => ipcRenderer.invoke(IPC_CHANNELS.aiGetChat, input),
    getPunctuationSuggestion: (documentNodeId) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiGetPunctuationSuggestion, documentNodeId),
    applyPunctuationSuggestion: (messageId) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiApplyPunctuationSuggestion, messageId),
    cancel: (messageId) => ipcRenderer.invoke(IPC_CHANNELS.aiCancelRun, messageId),
    get: (messageId) => ipcRenderer.invoke(IPC_CHANNELS.aiGetRun, messageId),
    onEvent: (handler) => {
      const listen = (_event: unknown, run: unknown) => {
        if (run && typeof run === "object") handler(run as Parameters<typeof handler>[0]);
      };
      ipcRenderer.on(IPC_CHANNELS.aiRunEvent, listen);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.aiRunEvent, listen);
      };
    },
  },
} satisfies MunhaeApi;

contextBridge.exposeInMainWorld("munhae", api);
contextBridge.exposeInMainWorld("munhaeStartup", {
  wait: () => ipcRenderer.invoke(STARTUP_CHANNELS.wait),
  enter: () => ipcRenderer.invoke(STARTUP_CHANNELS.enter),
} satisfies StartupApi);
