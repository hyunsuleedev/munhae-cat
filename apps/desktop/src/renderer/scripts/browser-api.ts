import { IPC_CHANNELS, type IpcChannel, type MunhaeApi } from "../../shared/munhae-api";

const BRIDGE_URL = "/__munhae/api";

async function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  const response = await fetch(BRIDGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const payload = await response.json() as { value?: T; error?: string };
  if (!response.ok) throw new Error(payload.error ?? "Electron 브리지에 연결할 수 없습니다.");
  return payload.value as T;
}

export function createBrowserApi(): MunhaeApi {
  return {
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
      // The development browser shares Electron's account; refresh on focus.
      onStateChanged: (handler) => {
        const refresh = () => { void invoke<Awaited<ReturnType<MunhaeApi["auth"]["getState"]>>>(IPC_CHANNELS.authGetState).then((result) => { if (result.ok) handler(result.data); }).catch(() => undefined); };
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
      },
    },
    app: {
      getVersion: () => invoke(IPC_CHANNELS.appGetVersion),
      getConfig: () => invoke(IPC_CHANNELS.appGetConfig),
      setConfig: (patch) => invoke(IPC_CHANNELS.appSetConfig, patch),
      probeAgents: () => invoke(IPC_CHANNELS.appProbeAgents),
      getLoginInstruction: (agentId) => invoke(IPC_CHANNELS.appGetLoginInstruction, agentId),
      quit: () => invoke(IPC_CHANNELS.appQuit),
      openExternal: (url) => invoke(IPC_CHANNELS.appOpenExternal, url),
      onCommand: () => () => undefined,
    },
    project: {
      create: (input) => invoke(IPC_CHANNELS.projectCreate, input),
      open: (packagePath) => invoke(IPC_CHANNELS.projectOpen, packagePath),
      close: () => invoke(IPC_CHANNELS.projectClose),
      getCurrent: () => invoke(IPC_CHANNELS.projectGetCurrent),
      listRecent: () => invoke(IPC_CHANNELS.projectListRecent),
      backup: () => invoke(IPC_CHANNELS.projectBackup),
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
      attachReference: (documentNodeId) => invoke(IPC_CHANNELS.editorAttachReference, documentNodeId),
      readReference: (documentNodeId, assetId) =>
        invoke(IPC_CHANNELS.editorReadReference, documentNodeId, assetId),
      openReference: (documentNodeId, assetId) =>
        invoke(IPC_CHANNELS.editorOpenReference, documentNodeId, assetId),
    },
    research: {
      searchFootnotes: (input) => invoke(IPC_CHANNELS.researchSearchFootnotes, input),
    },
    knowledge: {
      get: () => invoke(IPC_CHANNELS.knowledgeGet),
      upsertGlossary: (entry) => invoke(IPC_CHANNELS.knowledgeUpsertGlossary, entry),
      upsertPerson: (person) => invoke(IPC_CHANNELS.knowledgeUpsertPerson, person),
      upsertPlace: (place) => invoke(IPC_CHANNELS.knowledgeUpsertPlace, place),
      createContext: (input) => invoke(IPC_CHANNELS.knowledgeCreateContext, input),
      updateContext: (input) => invoke(IPC_CHANNELS.knowledgeUpdateContext, input),
      setContextEnabled: (input) => invoke(IPC_CHANNELS.knowledgeSetContextEnabled, input),
      setContextPriority: (input) => invoke(IPC_CHANNELS.knowledgeSetContextPriority, input),
      archiveContext: (input) => invoke(IPC_CHANNELS.knowledgeArchiveContext, input),
      createUncertainty: (input) => invoke(IPC_CHANNELS.knowledgeCreateUncertainty, input),
      versionUncertainty: (input) => invoke(IPC_CHANNELS.knowledgeVersionUncertainty, input),
      resolveUncertainty: (input) => invoke(IPC_CHANNELS.knowledgeResolveUncertainty, input),
    },
    context: {
      preview: (input) => invoke(IPC_CHANNELS.contextPreview, input),
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
