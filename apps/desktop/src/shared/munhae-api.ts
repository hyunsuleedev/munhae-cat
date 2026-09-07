/**
 * Renderer ↔ preload ↔ main typed IPC contract.
 * Keep this file free of Node/Electron imports so the renderer can import types.
 */

export const IPC_CHANNELS = {
  appGetVersion: "munhae:app:getVersion",
  appGetConfig: "munhae:app:getConfig",
  appSetConfig: "munhae:app:setConfig",
  appProbeAgents: "munhae:app:probeAgents",
  appGetLoginInstruction: "munhae:app:getLoginInstruction",
  appQuit: "munhae:app:quit",
  appShowAbout: "munhae:app:showAbout",
  appOpenExternal: "munhae:app:openExternal",
  appOpenPath: "munhae:app:openPath",
  menuCommand: "munhae:menu:command",

  authGetState: "munhae:auth:getState",
  authSignUp: "munhae:auth:signUp",
  authSignIn: "munhae:auth:signIn",
  authSignInWithGoogle: "munhae:auth:signInWithGoogle",
  authCancelGoogleSignIn: "munhae:auth:cancelGoogleSignIn",
  authSignOut: "munhae:auth:signOut",
  authVerifyCode: "munhae:auth:verifyCode",
  authResendConfirmation: "munhae:auth:resendConfirmation",
  authRequestPasswordReset: "munhae:auth:requestPasswordReset",
  authUpdatePassword: "munhae:auth:updatePassword",
  authStateChanged: "munhae:auth:stateChanged",

  projectCreate: "munhae:project:create",
  projectOpen: "munhae:project:open",
  projectClose: "munhae:project:close",
  projectGetCurrent: "munhae:project:getCurrent",
  projectListRecent: "munhae:project:listRecent",
  projectBackup: "munhae:project:backup",
  projectExportConfirmed: "munhae:project:exportConfirmed",
  projectSearch: "munhae:project:search",
  projectCreateFromPaste: "munhae:project:createFromPaste",
  projectSeedDemo: "munhae:project:seedDemo",

  homeGet: "munhae:home:get",
  documentCreate: "munhae:document:create",
  documentPickText: "munhae:document:pickText",
  documentGetMetadata: "munhae:document:getMetadata",
  documentUpdateMetadata: "munhae:document:updateMetadata",

  editorGet: "munhae:editor:get",
  editorSaveSourceDraft: "munhae:editor:saveSourceDraft",
  editorConfirmSource: "munhae:editor:confirmSource",
  editorCreatePunctuationDraft: "munhae:editor:createPunctuationDraft",
  editorSavePunctuationDraft: "munhae:editor:savePunctuationDraft",
  editorConfirmPunctuation: "munhae:editor:confirmPunctuation",
  editorCreateTranslationDraft: "munhae:editor:createTranslationDraft",
  editorResetTranslationDraft: "munhae:editor:resetTranslationDraft",
  editorSaveDraft: "munhae:editor:saveDraft",
  editorConfirm: "munhae:editor:confirm",
  editorRevise: "munhae:editor:revise",
  editorMergeBlocks: "munhae:editor:mergeBlocks",
  editorSplitBlock: "munhae:editor:splitBlock",
  editorGetHistory: "munhae:editor:getHistory",
  editorCompareVersions: "munhae:editor:compareVersions",
  editorListReviewComments: "munhae:editor:listReviewComments",
  editorCreateReviewComment: "munhae:editor:createReviewComment",
  editorUpdateReviewComment: "munhae:editor:updateReviewComment",
  editorArchiveReviewComment: "munhae:editor:archiveReviewComment",
  editorAttachReference: "munhae:editor:attachReference",
  editorReadReference: "munhae:editor:readReference",
  editorOpenReference: "munhae:editor:openReference",

  knowledgeGet: "munhae:knowledge:get",
  knowledgeUpsertGlossary: "munhae:knowledge:upsertGlossary",
  knowledgeUpsertPerson: "munhae:knowledge:upsertPerson",
  knowledgeUpsertPlace: "munhae:knowledge:upsertPlace",
  knowledgeCreateContext: "munhae:knowledge:createContext",
  knowledgeUpdateContext: "munhae:knowledge:updateContext",
  knowledgeSetContextEnabled: "munhae:knowledge:setContextEnabled",
  knowledgeSetContextPriority: "munhae:knowledge:setContextPriority",
  knowledgeArchiveContext: "munhae:knowledge:archiveContext",
  knowledgeCreateUncertainty: "munhae:knowledge:createUncertainty",
  knowledgeVersionUncertainty: "munhae:knowledge:versionUncertainty",
  knowledgeResolveUncertainty: "munhae:knowledge:resolveUncertainty",

  contextPreview: "munhae:context:preview",

  aiStartTranslation: "munhae:ai:startTranslation",
  aiStartChat: "munhae:ai:startChat",
  aiStartPunctuation: "munhae:ai:startPunctuation",
  aiGetChat: "munhae:ai:getChat",
  aiGetPunctuationSuggestion: "munhae:ai:getPunctuationSuggestion",
  aiApplyPunctuationSuggestion: "munhae:ai:applyPunctuationSuggestion",
  aiCancelRun: "munhae:ai:cancelRun",
  aiGetRun: "munhae:ai:getRun",
  aiRunEvent: "munhae:ai:runEvent",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type AppConfig = {
  agentId: "codex" | "claude" | "antigravity";
  agentModels: {
    codex: { model: string; reasoning: string | null; serviceTier: string | null };
    antigravity: { model: string; reasoning: string | null; serviceTier: string | null };
    claude: { model: string; reasoning: string | null; serviceTier: string | null };
  };
  showWelcomeOnLaunch: boolean;
};

export type AgentProbe = {
  agentId: "codex" | "claude" | "antigravity";
  displayName: string;
  installed: boolean;
  loggedIn: boolean | null;
  version: string | null;
  capabilities: {
    jsonStreaming: boolean;
    resume: boolean;
    modelSelection: boolean;
    reasoningEffort: boolean;
    serviceTier: boolean;
    structuredOutput: boolean;
    nativeTools: boolean;
    explicitSessionId: boolean;
  };
  capabilitySource: "live" | "unavailable";
  models: Array<{
    id: string;
    label: string;
    defaultReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    reasoningOptions?: Array<{ id: string; label: string }>;
    serviceTierOptions?: Array<{ id: string; label: string }>;
  }>;
  modelSource: "live" | "fallback";
  reasoningOptions: Array<{ id: string; label: string }>;
  serviceTierOptions: Array<{ id: string; label: string }>;
  lastCheckedAt: string;
  detail: string;
};

export type AgentLoginInstruction = {
  agentId: AgentProbe["agentId"];
  available: boolean;
  displayCommand: string;
  requiresInteractiveTerminal: true;
  detail: string;
};

export type ProjectSummary = {
  projectId: string;
  title: string;
  packagePath: string;
  storageMode: "local";
  openedAt: string;
};

export type RecentProject = {
  projectId: string;
  displayName: string;
  packagePath: string;
  lastOpenedAt: string;
  missing: boolean;
};

export type CreateProjectInput = {
  title: string;
  parentDir?: string;
};

export type CreateFromPasteInput = {
  title: string;
  sourceText: string;
  parentDir?: string;
};


export type DocumentNodeRole = "container" | "source_unit";


export type VersionUiState = "draft" | "confirmed" | "review" | "none";

export type DocumentListItem = {
  id: string;
  parentId: string | null;
  depth: number;
  nodeRole: DocumentNodeRole;
  isMaster: boolean;
  title: string;
  originalTitle: string | null;
  ordinal: number;
  sourceState: VersionUiState;
  punctuationState: VersionUiState;
  translationState: VersionUiState;
  uncertaintyCount: number;
  contextCount: number;
};

export type HomeView = {
  project: ProjectSummary;
  documents: DocumentListItem[];
  progress: { sourceConfirmed: number; punctuationConfirmed: number; translationDraft: number; translationConfirmed: number; total: number };
  uncertainties: Array<{ id: string; label: string; category: string; locator: string }>;
  recent: Array<{ title: string; summary: string; when: string; tag: string }>;
  agents: AgentProbe[];
};

type CreateDocumentBaseInput = {
  title: string;
  originalTitle?: string | null;
  parentId: string | null;
};

export type CreateDocumentInput =
  | (CreateDocumentBaseInput & {
      nodeRole: "container";
      originKind?: never;
      sourceText?: never;
    })
  | (CreateDocumentBaseInput & {
      nodeRole: "source_unit";
      originKind: "paste" | "manual" | "import";
      sourceText: string;
    });

export type DocumentMetadataView = {
  id: string;
  parentId: string | null;
  nodeRole: DocumentNodeRole;
  isMaster: boolean;
  title: string;
  originalTitle: string | null;
  authorPersonId: string | null;
  authorName: string | null;
  language: string | null;
  periodText: string | null;
  dateText: string | null;
  descriptionMd: string | null;
  sourceReference: string | null;
  lockVersion: number;
  updatedAt: string;
};

export type UpdateDocumentMetadataInput = {
  documentNodeId: string;
  title: string;
  originalTitle: string | null;
  authorPersonId: string | null;
  language: string | null;
  periodText: string | null;
  dateText: string | null;
  descriptionMd: string | null;
  sourceReference: string | null;
  expectedLockVersion: number;
};

export type TranslationBlockView = {
  blockKey: string;
  ordinal: number;
  blockKind: string;
  translation: string;
  sourceAnchorIds: string[];
  relationKinds: string[];
};

export type ReferenceAssetView = {
  id: string;
  assetKind: "image" | "pdf";
  originalFilename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  pageCount: number | null;
  role: "reference";
  pageFrom: number | null;
  pageTo: number | null;
  locatorText: string | null;
  ordinal: number;
  state: "present" | "missing" | "unsafe_path" | "size_mismatch" | "hash_mismatch";
  verifiedAt: string;
};

export type ReferenceAssetContent = {
  assetId: string;
  mimeType: string;
  base64: string;
};

export type StructureMode = "prose" | "poetry";

export type StructureSpanKind =
  | "paragraph"
  | "sentence"
  | "verse_line"
  | "couplet"
  | "stanza";

export type StructureSpanInput = {
  spanKey: string;
  spanKind: StructureSpanKind;
  parentSpanKey?: string | null;
  ordinal: number;
  codepointFrom: number;
  codepointTo: number;
  label?: string | null;
};

export type StructureSpanView = {
  id: string;
  spanKind: string;
  parentSpanId: string | null;
  ordinal: number;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  label: string | null;
};

export type EditorView = {
  project: ProjectSummary;
  document: {
    id: string;
    title: string;
    originalTitle: string | null;
    nodeRole: DocumentNodeRole;
    authorName: string | null;
    periodText: string | null;
    dateText: string | null;
    language: string | null;
    sourceReference: string | null;
  };
  referenceAssets: ReferenceAssetView[];
  source: {
    versionId: string;
    versionNo: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    contentText: string;
    lockVersion: number;
  };
  punctuation: {
    versionId: string;
    versionNo: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    punctuatedText: string;
    lockVersion: number;
    structureMode: StructureMode;
    structureSpans: StructureSpanView[];
    anchorSetId: string | null;
  } | null;
  anchors: Array<{
    anchorKey: string;
    ordinal: number;
    boundaryKind: string;
    punctuationFrom: number;
    punctuationTo: number;
    punctuatedQuote: string;
  }>;
  translation: {
    versionId: string;
    versionNo: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    validationState: "valid" | "needs_review";
    textContent: string;
    textLayout?: {
      state: "pending" | "running" | "ready" | "needs_review" | "failed";
      sentences: Array<{ id: string; from: number; to: number; text: string }>;
      links: Array<{ sentenceId: string; spans: Array<{ from: number; to: number; quote: string }>; needsReview: boolean }>;
      error: string | null;
    };
    originKind: string;
    isCurrentDependencies: boolean;
    lockVersion: number;
    blocks: TranslationBlockView[];
  } | null;
  chat: Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    meta?: string;
  }>;
};

export type SaveSourceDraftInput = {
  documentNodeId: string;
  contentText: string;
  originKind: "manual" | "paste" | "import";
  changeSummary?: string | null;
  expectedLockVersion: number;
};

export type ConfirmSourceInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type CreatePunctuationDraftInput = {
  documentNodeId: string;
  structureMode: StructureMode;
  expectedSourceLockVersion: number;
};

export type SavePunctuationDraftInput = {
  documentNodeId: string;
  punctuatedText: string;
  structureMode: StructureMode;
  structureSpans?: StructureSpanInput[];
  changeSummary?: string | null;
  expectedLockVersion: number;
};

export type ConfirmPunctuationInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type SaveTranslationDraftInput = {
  documentNodeId: string;
  textContent: string;
  blocks: Array<{
    blockKey: string;
    blockKind: string;
    translation: string;
    sourceAnchorIds: string[];
    relationKinds?: string[];
  }>;
  expectedLockVersion: number;
};

export type CreateTranslationDraftInput = {
  fullText?: boolean;
  documentNodeId: string;
  expectedSourceLockVersion: number;
  expectedPunctuationLockVersion: number;
};

export type ResetTranslationDraftInput = CreateTranslationDraftInput & {
  expectedTranslationLockVersion: number;
};

export type ConfirmTranslationInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type ReviseTranslationInput = ConfirmTranslationInput;

export type ReviewCommentView = {
  id: string;
  documentNodeId: string;
  translationVersionId: string;
  targetKind: "source" | "translation";
  targetVersionId: string;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  bodyMd: string;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateReviewCommentInput = Omit<ReviewCommentView, "id" | "lockVersion" | "createdAt" | "updatedAt">;
export type UpdateReviewCommentInput = { id: string; bodyMd: string; expectedLockVersion: number };
export type ArchiveReviewCommentInput = { id: string; expectedLockVersion: number };

export type MergeBlocksInput = {
  documentNodeId: string;
  leftBlockKey: string;
  rightBlockKey: string;
  expectedLockVersion: number;
};

export type SplitBlockInput = {
  documentNodeId: string;
  blockKey: string;
  splitAt: number;
  anchorSplitAt?: number;
  expectedLockVersion: number;
};

export type GlossaryEntryView = {
  id: string;
  contentHash: string;
  lockVersion: number;
  sourceTerm: string;
  targetTerm: string;
  targetLocale: string;
  termKind: string;
  reading: string | null;
  noteMd: string | null;
  usageStatus: "preferred" | "allowed" | "forbidden";
};

export type PersonView = {
  id: string;
  contentHash: string;
  lockVersion: number;
  preferredName: string;
  hanjaName: string | null;
  reading: string | null;
  aliases: string[];
  descriptionMd: string | null;
  dateText: string | null;
};

export type PlaceView = {
  id: string;
  contentHash: string;
  lockVersion: number;
  preferredName: string;
  hanjaName: string | null;
  reading: string | null;
  aliases: string[];
  placeKind: string | null;
  locationNoteMd: string | null;
  descriptionMd: string | null;
};

export type UpsertGlossaryInput = Omit<GlossaryEntryView, "id" | "contentHash" | "lockVersion"> & {
  id?: string;
  expectedLockVersion?: number;
};

export type UpsertPersonInput = Omit<PersonView, "id" | "contentHash" | "lockVersion"> & {
  id?: string;
  expectedLockVersion?: number;
};

export type UpsertPlaceInput = Omit<PlaceView, "id" | "contentHash" | "lockVersion"> & {
  id?: string;
  expectedLockVersion?: number;
};

export type UncertaintyView = {
  id: string;
  versionId: string;
  versionNo: number;
  category: "textual" | "interpretive" | "identification";
  severity: string;
  blocking: boolean;
  state: "open" | "resolved";
  statementMd: string;
  rationaleMd: string | null;
  confidenceLabel: string | null;
  options: Array<{ id: string; label: string; interpretationMd: string | null; ordinal: number }>;
  anchors: Array<{
    id: string;
    targetKind: UncertaintyAnchorInput["targetKind"];
    targetVersionId: string;
    codepointFrom: number | null;
    codepointTo: number | null;
    quote: string | null;
  }>;
  locator: string;
};

export type UncertaintyOptionInput = { label: string; interpretationMd?: string | null };

export type UncertaintyAnchorInput = {
  targetKind:
    | "document_node"
    | "source_text_version"
    | "punctuation_version"
    | "translation_anchor"
    | "document_translation"
    | "document_translation_version";
  targetVersionId: string;
  codepointFrom?: number | null;
  codepointTo?: number | null;
  quote?: string | null;
};

export type CreateUncertaintyInput = {
  category: UncertaintyView["category"];
  severity: string;
  blocking: boolean;
  statementMd: string;
  rationaleMd?: string | null;
  confidenceLabel?: string | null;
  options: UncertaintyOptionInput[];
  anchors: UncertaintyAnchorInput[];
};

export type CreateUncertaintyVersionInput = CreateUncertaintyInput & {
  uncertaintyId: string;
  expectedVersionId: string;
};

export type ResolveUncertaintyInput = { uncertaintyId: string; expectedVersionId: string };

export type NodeContextView = {
  id: string;
  source: "context_item" | "document_description";
  scopeKind: "document_node";
  scopeId: string;
  title: string;
  contentMd: string;
  priority: number;
  enabled: boolean;
  lockVersion: number;
  updatedAt: string;
};

export type CreateContextItemInput = {
  scopeId: string;
  title: string;
  contentMd: string;
  priority: number;
  enabled: boolean;
};

export type UpdateContextItemInput = CreateContextItemInput & { id: string; expectedLockVersion: number };
export type ContextItemCasInput = { id: string; expectedLockVersion: number };
export type SetContextItemEnabledInput = ContextItemCasInput & { enabled: boolean };
export type SetContextItemPriorityInput = ContextItemCasInput & { priority: number };

export type KnowledgeView = {
  glossary: GlossaryEntryView[];
  persons: PersonView[];
  places: PlaceView[];
  uncertainties: UncertaintyView[];
  contextItems: NodeContextView[];
};

export type ContextPreview = {
  characterCount: number;
  utf8ByteCount: number;
  manifestHash: string;
  requestHash: string;
  requestText: string;
  promptContractVersion: string;
  required: Array<{
    kind: string;
    label: string;
    version?: string;
    hash: string;
    chars: number;
    content: string;
  }>;
  auxiliary: Array<{
    id: string;
    kind: string;
    label: string;
    reason: string;
    included: boolean;
    defaultIncluded: boolean;
    selection: "auto" | "pin" | "exclude";
    hash: string;
    chars: number;
    content: string;
  }>;
  status: "ready";
  manifestJson: string;
};

export type TranslationRevisionInput = {
  baseVersionId: string;
  commentIds: string[];
};

export type ContextPreviewInput = {
  documentNodeId: string;
  selections?: Array<{ id: string; mode: "auto" | "pin" | "exclude" }>;
  revision?: TranslationRevisionInput;
};

export type StartTranslationInput = {
  alignmentVersionId?: string;
  documentNodeId: string;
  selections?: Array<{ id: string; mode: "auto" | "pin" | "exclude" }>;
  revision?: TranslationRevisionInput;
  agentId: AgentProbe["agentId"];
};

export type ChatScopeKind = "document_node" | "project";

export type StartProjectChatInput = {
  documentNodeId: string;
  scopeKind: ChatScopeKind;
  question: string;
  agentId: AgentProbe["agentId"];
};

export type GetProjectChatInput = Pick<StartProjectChatInput, "documentNodeId" | "scopeKind">;

export type StartPunctuationSuggestionInput = {
  documentNodeId: string;
  structureMode: StructureMode;
  agentId: AgentProbe["agentId"];
};

export type PunctuationSuggestionView = {
  validationError: string | null;
  messageId: string;
  documentNodeId: string;
  agentId: AgentProbe["agentId"];
  responseText: string;
  createdAt: string;
  validationState: "valid" | "invalid_unapplied";
  applied: boolean;
  punctuationVersionId: string | null;
  anchorSetId: string | null;
};

export type PunctuationSuggestionApplyResult = Pick<
  PunctuationSuggestionView,
  "messageId" | "validationState" | "applied" | "punctuationVersionId" | "anchorSetId"
>;

export type AiRunView = {
  messageId: string;
  documentNodeId: string;
  chatScopeKind?: ChatScopeKind;
  agentId: AgentProbe["agentId"];
  taskKind: "translation" | "chat" | "punctuation_suggest";
  state: "running" | "completed" | "failed" | "canceled";
  phase: string;
  detail: string | null;
  partialText: string;
  error: { code: string; message: string } | null;
  validationState: "valid" | "needs_review" | "invalid_unapplied" | null;
  startedAt: string;
  completedAt: string | null;
};

export type VersionHistoryKind = "source" | "punctuation" | "translation";

export type HistoryAnchorLink = {
  anchorId: string;
  anchorKey: string;
  ordinal: number;
  relationKind: string;
  boundaryKind: string;
  sourceCodepointFrom: number;
  sourceCodepointTo: number;
  sourceQuote: string;
  sourceQuoteHash: string;
  punctuationCodepointFrom: number;
  punctuationCodepointTo: number;
  punctuatedQuote: string;
  punctuatedQuoteHash: string;
};

export type HistoryBlock = {
  blockKey: string;
  ordinal: number;
  blockKind: string;
  translation: string;
  targetHash: string;
  validationState: "valid" | "needs_review";
  anchors: HistoryAnchorLink[];
};

export type VersionHistoryEntry = {
  kind: VersionHistoryKind;
  aggregateId: string;
  stage: string | null;
  versionId: string;
  parentVersionId: string | null;
  versionNo: number;
  state: "draft" | "confirmed" | "rejected" | "superseded";
  isCurrent: boolean;
  isConfirmed: boolean;
  contentHash: string;
  contentText: string;
  createdAt: string;
  createdBy: string;
  originKind: string;
  changeSummary: string | null;
  validationState: "valid" | "needs_review" | null;
  sourceTextVersionId: string | null;
  sourceTextHash: string | null;
  punctuationVersionId: string | null;
  punctuationHash: string | null;
  anchorSetId: string | null;
  anchorSetHash: string | null;
  translationPolicyVersionId: string | null;
  translationPolicyHash: string | null;
  structureJson: string | null;
  structureSpanCount: number;
  blocks: HistoryBlock[];
};

export type DocumentHistoryView = {
  documentNodeId: string;
  documentTitle: string;
  entries: VersionHistoryEntry[];
};

export type VersionDiffInput = {
  documentNodeId: string;
  kind: VersionHistoryKind;
  stage?: string | null;
  baseVersionId: string;
  targetVersionId: string;
};

export type VersionDiffView = {
  kind: VersionHistoryKind;
  stage: string | null;
  aggregateId: string;
  base: { versionId: string; versionNo: number; contentHash: string; state: string };
  target: { versionId: string; versionNo: number; contentHash: string; state: string };
  chunks: Array<{ type: "equal" | "remove" | "add"; text: string }>;
};

export type ConfirmedExportFormat = "markdown" | "json" | "csv";
export type ConfirmedExportInput = {
  format: ConfirmedExportFormat;
  documentNodeId?: string | null;
};
export type ExportSaveResult = {
  filePath: string;
  format: ConfirmedExportFormat;
  confirmedTranslationCount: number;
  manifestHash: string;
};

export type SearchEntityType = "glossary" | "person" | "place";
export type SearchEntityFilterInput = {
  entityType: SearchEntityType;
  entityId: string;
};
export type ResolvedSearchEntityFilter = SearchEntityFilterInput & {
  label: string;
  terms: string[];
};
export type SearchQueryInput = {
  query: string;
  scope?: "all" | "source" | "translation";
  state?: "current" | "confirmed" | "all";
  documentNodeId?: string | null;
  entityFilter?: SearchEntityFilterInput | null;
  limit?: number;
};
export type SearchResult = {
  resultKind: "source" | "translation";
  documentNodeId: string;
  documentTitle: string;
  aggregateId: string;
  versionId: string;
  versionNo: number;
  contentHash: string;
  stage: string | null;
  state: string;
  isCurrent: boolean;
  isConfirmed: boolean;
  matchKind: "exact" | "prefix" | "fts";
  snippet: string;
};
export type SearchView = {
  query: string;
  scope: NonNullable<SearchQueryInput["scope"]>;
  state: NonNullable<SearchQueryInput["state"]>;
  entityFilter: ResolvedSearchEntityFilter | null;
  usedShortHanPrefix: boolean;
  rebuiltFromLedger: true;
  results: SearchResult[];
};

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type AccountUser = {
  id: string;
  email: string;
  displayName: string;
  emailConfirmedAt: string | null;
  providers: Array<"email" | "google">;
};

export type AccountState = {
  status: "signed_out" | "signed_in" | "password_recovery";
  user: AccountUser | null;
  persistence: "encrypted" | "memory";
};
export type AccountCredentials = { email: string; password: string };
export type AccountSignUpInput = AccountCredentials & { displayName: string };
export type AccountVerifyInput = { email: string; code: string; purpose: "signup" | "recovery" };
export type AccountPasswordInput = { password: string; currentPassword?: string };

export type MunhaeApi = {
  auth: {
    getState(): Promise<IpcResult<AccountState>>;
    signUp(input: AccountSignUpInput): Promise<IpcResult<{ state: AccountState; confirmationRequired: boolean }>>;
    signIn(input: AccountCredentials): Promise<IpcResult<AccountState>>;
    signInWithGoogle(): Promise<IpcResult<AccountState>>;
    cancelGoogleSignIn(): Promise<IpcResult<boolean>>;
    signOut(): Promise<IpcResult<AccountState>>;
    verifyCode(input: AccountVerifyInput): Promise<IpcResult<AccountState>>;
    resendConfirmation(email: string): Promise<IpcResult<void>>;
    requestPasswordReset(email: string): Promise<IpcResult<void>>;
    updatePassword(input: AccountPasswordInput): Promise<IpcResult<AccountState>>;
    onStateChanged(handler: (state: AccountState) => void): () => void;
  };
  app: {
    getVersion(): Promise<string>;
    getConfig(): Promise<AppConfig>;
    setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
    probeAgents(): Promise<AgentProbe[]>;
    getLoginInstruction(agentId: AgentProbe["agentId"]): Promise<AgentLoginInstruction>;
    quit(): Promise<void>;
    openExternal(url: string): Promise<void>;
    onCommand(handler: (id: string) => void): () => void;
  };
  project: {
    create(input: CreateProjectInput): Promise<IpcResult<ProjectSummary>>;
    open(packagePath?: string): Promise<IpcResult<ProjectSummary | null>>;
    close(): Promise<IpcResult<void>>;
    getCurrent(): Promise<ProjectSummary | null>;
    listRecent(): Promise<RecentProject[]>;
    backup(): Promise<IpcResult<string | null>>;
    exportConfirmed(input: ConfirmedExportInput): Promise<IpcResult<ExportSaveResult | null>>;
    search(input: SearchQueryInput): Promise<IpcResult<SearchView>>;
    createFromPaste(input: CreateFromPasteInput): Promise<IpcResult<ProjectSummary>>;
    seedDemo(): Promise<IpcResult<ProjectSummary>>;
  };
  home: {
    get(): Promise<IpcResult<HomeView>>;
    createDocument(input: CreateDocumentInput): Promise<IpcResult<DocumentListItem>>;
    pickTextFile(): Promise<IpcResult<string | null>>;
    getDocumentMetadata(documentNodeId: string): Promise<IpcResult<DocumentMetadataView>>;
    updateDocumentMetadata(input: UpdateDocumentMetadataInput): Promise<IpcResult<DocumentMetadataView>>;
  };
  editor: {
    get(documentNodeId: string): Promise<IpcResult<EditorView>>;
    saveSourceDraft(input: SaveSourceDraftInput): Promise<IpcResult<EditorView>>;
    confirmSource(input: ConfirmSourceInput): Promise<IpcResult<EditorView>>;
    createPunctuationDraft(input: CreatePunctuationDraftInput): Promise<IpcResult<EditorView>>;
    savePunctuationDraft(input: SavePunctuationDraftInput): Promise<IpcResult<EditorView>>;
    confirmPunctuation(input: ConfirmPunctuationInput): Promise<IpcResult<EditorView>>;
    createTranslationDraft(input: CreateTranslationDraftInput): Promise<IpcResult<EditorView>>;
    resetTranslationDraft(input: ResetTranslationDraftInput): Promise<IpcResult<EditorView>>;
    saveDraft(input: SaveTranslationDraftInput): Promise<IpcResult<EditorView>>;
    confirm(input: ConfirmTranslationInput): Promise<IpcResult<EditorView>>;
    revise(input: ReviseTranslationInput): Promise<IpcResult<EditorView>>;
    mergeBlocks(input: MergeBlocksInput): Promise<IpcResult<EditorView>>;
    splitBlock(input: SplitBlockInput): Promise<IpcResult<EditorView>>;
    getHistory(documentNodeId: string): Promise<IpcResult<DocumentHistoryView>>;
    compareVersions(input: VersionDiffInput): Promise<IpcResult<VersionDiffView>>;
    listReviewComments(documentNodeId: string): Promise<IpcResult<ReviewCommentView[]>>;
    createReviewComment(input: CreateReviewCommentInput): Promise<IpcResult<ReviewCommentView>>;
    updateReviewComment(input: UpdateReviewCommentInput): Promise<IpcResult<ReviewCommentView>>;
    archiveReviewComment(input: ArchiveReviewCommentInput): Promise<IpcResult<void>>;
    attachReference(documentNodeId: string): Promise<IpcResult<EditorView | null>>;
    readReference(documentNodeId: string, assetId: string): Promise<IpcResult<ReferenceAssetContent>>;
    openReference(documentNodeId: string, assetId: string): Promise<IpcResult<void>>;
  };
  knowledge: {
    get(): Promise<IpcResult<KnowledgeView>>;
    upsertGlossary(entry: UpsertGlossaryInput): Promise<IpcResult<GlossaryEntryView>>;
    upsertPerson(person: UpsertPersonInput): Promise<IpcResult<PersonView>>;
    upsertPlace(place: UpsertPlaceInput): Promise<IpcResult<PlaceView>>;
    createContext(input: CreateContextItemInput): Promise<IpcResult<NodeContextView>>;
    updateContext(input: UpdateContextItemInput): Promise<IpcResult<NodeContextView>>;
    setContextEnabled(input: SetContextItemEnabledInput): Promise<IpcResult<NodeContextView>>;
    setContextPriority(input: SetContextItemPriorityInput): Promise<IpcResult<NodeContextView>>;
    archiveContext(input: ContextItemCasInput): Promise<IpcResult<void>>;
    createUncertainty(input: CreateUncertaintyInput): Promise<IpcResult<UncertaintyView>>;
    versionUncertainty(input: CreateUncertaintyVersionInput): Promise<IpcResult<UncertaintyView>>;
    resolveUncertainty(input: ResolveUncertaintyInput): Promise<IpcResult<UncertaintyView>>;
  };
  context: {
    preview(input: ContextPreviewInput): Promise<IpcResult<ContextPreview>>;
  };
  ai: {
    startTranslation(input: StartTranslationInput): Promise<IpcResult<AiRunView>>;
    startChat(input: StartProjectChatInput): Promise<IpcResult<AiRunView>>;
    startPunctuation(input: StartPunctuationSuggestionInput): Promise<IpcResult<AiRunView>>;
    getChat(input: GetProjectChatInput): Promise<IpcResult<EditorView["chat"]>>;
    getPunctuationSuggestion(documentNodeId: string): Promise<IpcResult<PunctuationSuggestionView | null>>;
    applyPunctuationSuggestion(messageId: string): Promise<IpcResult<PunctuationSuggestionApplyResult>>;
    cancel(messageId: string): Promise<IpcResult<AiRunView>>;
    get(messageId: string): Promise<IpcResult<AiRunView>>;
    onEvent(handler: (run: AiRunView) => void): () => void;
  };
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  agentId: "claude",
  agentModels: {
    codex: { model: "default", reasoning: "medium", serviceTier: null },
    antigravity: { model: "default", reasoning: null, serviceTier: null },
    claude: { model: "default", reasoning: null, serviceTier: null },
  },
  showWelcomeOnLaunch: true,
};
