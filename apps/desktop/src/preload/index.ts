/// <reference path="./index.d.ts" />

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS, type MunhaeApi } from "../shared/munhae-api";
import { STARTUP_CHANNELS, type StartupApi } from "../shared/startup-api";

const api = {
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
  project: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectCreate, input),
    open: (packagePath) => ipcRenderer.invoke(IPC_CHANNELS.projectOpen, packagePath),
    close: () => ipcRenderer.invoke(IPC_CHANNELS.projectClose),
    getCurrent: () => ipcRenderer.invoke(IPC_CHANNELS.projectGetCurrent),
    listRecent: () => ipcRenderer.invoke(IPC_CHANNELS.projectListRecent),
    backup: () => ipcRenderer.invoke(IPC_CHANNELS.projectBackup),
    concordance: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectConcordance, input),
    exportReview: (input) => ipcRenderer.invoke(IPC_CHANNELS.projectExportReview, input),
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
    searchFootnotes: (input) => ipcRenderer.invoke(IPC_CHANNELS.researchSearchFootnotes, input),
    startFootnoteAnalysis: (input) => ipcRenderer.invoke(IPC_CHANNELS.researchStartFootnoteAnalysis, input),
    getFootnoteAnalysis: (id) => ipcRenderer.invoke(IPC_CHANNELS.researchGetFootnoteAnalysis, id),
    cancelFootnoteAnalysis: (id) => ipcRenderer.invoke(IPC_CHANNELS.researchCancelFootnoteAnalysis, id),
  },
  knowledge: {
    getMaterials: (documentNodeId) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGetMaterials, documentNodeId),
    setMaterialPreference: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSetMaterialPreference, input),
    reuseCommentAsMaterial: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeReuseCommentAsMaterial, input),
    get: () => ipcRenderer.invoke(IPC_CHANNELS.knowledgeGet),
    upsertGlossary: (entry) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeUpsertGlossary, entry),
    createContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeCreateContext, input),
    updateContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeUpdateContext, input),
    setContextEnabled: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSetContextEnabled, input),
    setContextPriority: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeSetContextPriority, input),
    archiveContext: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeArchiveContext, input),
    createUncertainty: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeCreateUncertainty, input),
    versionUncertainty: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeVersionUncertainty, input),
    resolveUncertainty: (input) => ipcRenderer.invoke(IPC_CHANNELS.knowledgeResolveUncertainty, input),
  },
  context: {
    preview: (input) => ipcRenderer.invoke(IPC_CHANNELS.contextPreview, input),
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
