import type { ProjectSharing, ProjectInvitation, InviteProjectMemberInput, UpdateProjectMemberInput } from "./online-projects";
import type { ReadingAnalysisApi } from "./reading-analysis-types";
export type { ReadingAnalysisInput, ReadingAnalysisRun, ReadingAnalysisSuggestion, ApplyReadingAnalysisInput } from "./reading-analysis-types";
import type { TermGlossarySelection } from "./term-glossary";
import type { BillingStatus } from "./billing";
export type { BillingStatus } from "./billing";
/**
 * Renderer ↔ preload ↔ main typed IPC contract.
 * Keep this file free of Node/Electron imports so the renderer can import types.
 */
import type { DictionarySearchInput, DictionarySearchResult, DictionarySetKeyInput, DictionaryStatus } from "./dictionary-types";
import type { ReadingAnnotationCasInput, ReadingAnnotationView, SaveReadingAnnotationInput } from "@munhae/db-sqlite";
export type { ReadingAnnotationCasInput, ReadingAnnotationView, ReadingCitation, SaveReadingAnnotationInput } from "@munhae/db-sqlite";

import type { MaterialOrigin, MaterialsView, SetMaterialPreferenceInput, ReuseCommentAsMaterialInput } from "@munhae/db-sqlite";
export type { MaterialOrigin, MaterialCommentView, MaterialPreferenceView, ResolvedMaterialView, MaterialsView, SetMaterialPreferenceInput, ReuseCommentAsMaterialInput } from "@munhae/db-sqlite";

import type { TermEntry, SaveTermInput } from "@munhae/db-sqlite";
import type { OnlineProject, CreateOnlineProjectInput, OnlineWorkspaceStatus, OpenOnlineProjectInput, ProjectChangeEvent } from "./online-projects";
export type { OnlineProject, CreateOnlineProjectInput, OnlineWorkspaceStatus, OpenOnlineProjectInput, ProjectChangeEvent } from "./online-projects";
export type { TermEntry, TermContent, SaveTermInput } from "@munhae/db-sqlite";
export type TermExtractionRun = { startedAt?: string; completedAt?: string | null; id: string; documentId: string; state: "running" | "completed" | "failed" | "canceled"; count: number; activity: ChatActivityBlock[]; error: { code: string; message: string } | null };
export const IPC_CHANNELS = {
  termsList: "munhae:terms:list",
  termsSave: "munhae:terms:save",
  termsDelete: "munhae:terms:delete",
  termsPromote: "munhae:terms:promote",
  termsStart: "munhae:terms:start",
  termsGetRun: "munhae:terms:getRun",
  termsLatestRun: "munhae:terms:latestRun",
  termsCancel: "munhae:terms:cancel",
  appGetVersion: "munhae:app:getVersion",
  appGetConfig: "munhae:app:getConfig",
  appSetConfig: "munhae:app:setConfig",
  appProbeAgents: "munhae:app:probeAgents",
  appGetLoginInstruction: "munhae:app:getLoginInstruction",
  appQuit: "munhae:app:quit",
  appCheckUpdates: "munhae:app:checkUpdates",
  appShowAbout: "munhae:app:showAbout",
  appCopyText: "munhae:app:copyText",
  appOpenChatSource: "munhae:app:openChatSource",
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

  billingGetStatus: "munhae:billing:getStatus",
  billingOpenCheckout: "munhae:billing:openCheckout",
  billingOpenPortal: "munhae:billing:openPortal",

  projectChanged: "munhae:project:changed",
  projectCreate: "munhae:project:create",
  onlineProjectsCreate: "munhae:onlineProjects:create",
  onlineProjectsOpen: "munhae:onlineProjects:open",
  onlineProjectsStatus: "munhae:onlineProjects:status",
  onlineProjectsSync: "munhae:onlineProjects:sync",
  onlineProjectsExportRecovery: "munhae:onlineProjects:exportRecovery",
  onlineProjectsList: "munhae:onlineProjects:list",
  onlineProjectsSharing: "munhae:onlineProjects:sharing",
  onlineProjectsInvitations: "munhae:onlineProjects:invitations",
  onlineProjectsInvite: "munhae:onlineProjects:invite",
  onlineProjectsRespond: "munhae:onlineProjects:respond",
  onlineProjectsCancelInvitation: "munhae:onlineProjects:cancelInvitation",
  onlineProjectsUpdateMember: "munhae:onlineProjects:updateMember",
  onlineProjectsGet: "munhae:onlineProjects:get",
  projectOpen: "munhae:project:open",
  projectClose: "munhae:project:close",
  projectGetCurrent: "munhae:project:getCurrent",
  projectListRecent: "munhae:project:listRecent",
  projectBackup: "munhae:project:backup",
  projectExportConfirmed: "munhae:project:exportConfirmed",
  projectSearch: "munhae:project:search",
  projectConcordance: "munhae:project:concordance",
  projectExportReview: "munhae:project:exportReview",
  projectCreateFromPaste: "munhae:project:createFromPaste",
  projectSeedDemo: "munhae:project:seedDemo",

  homeGet: "munhae:home:get",
  documentCreate: "munhae:document:create",
  documentPickText: "munhae:document:pickText",
  documentGetMetadata: "munhae:document:getMetadata",
  documentMove: "munhae:document:move",
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
  editorSaveSentenceLink: "munhae:editor:saveSentenceLink",
  editorCreateReviewComment: "munhae:editor:createReviewComment",
  editorUpdateReviewComment: "munhae:editor:updateReviewComment",
  editorArchiveReviewComment: "munhae:editor:archiveReviewComment",
  editorListReadingAnnotations: "munhae:editor:listReadingAnnotations",
  editorSaveReadingAnnotation: "munhae:editor:saveReadingAnnotation",
  editorArchiveReadingAnnotation: "munhae:editor:archiveReadingAnnotation",
  editorAttachReference: "munhae:editor:attachReference",
  editorReadReference: "munhae:editor:readReference",
  editorOpenReference: "munhae:editor:openReference",

  knowledgeGet: "munhae:knowledge:get",
  knowledgeGetMaterials: "munhae:knowledge:getMaterials",
  knowledgeSetMaterialPreference: "munhae:knowledge:setMaterialPreference",
  knowledgeReuseCommentAsMaterial: "munhae:knowledge:reuseCommentAsMaterial",
  knowledgeUpsertGlossary: "munhae:knowledge:upsertGlossary",
  knowledgeCreateContext: "munhae:knowledge:createContext",
  knowledgeUpdateContext: "munhae:knowledge:updateContext",
  knowledgeSetContextEnabled: "munhae:knowledge:setContextEnabled",
  knowledgeSetContextPriority: "munhae:knowledge:setContextPriority",
  knowledgeDeleteContext: "munhae:knowledge:deleteContext",
  knowledgeCreateUncertainty: "munhae:knowledge:createUncertainty",
  knowledgeVersionUncertainty: "munhae:knowledge:versionUncertainty",
  knowledgeResolveUncertainty: "munhae:knowledge:resolveUncertainty",

  contextPreview: "munhae:context:preview",
  researchSearchFootnotes: "munhae:research:searchFootnotes",
  researchStartMaterialRefinement: "munhae:research:startMaterialRefinement",
  researchGetMaterialRefinement: "munhae:research:getMaterialRefinement",
  researchCancelMaterialRefinement: "munhae:research:cancelMaterialRefinement",
  researchStartReadingAnalysis: "munhae:research:startReadingAnalysis",
  researchGetReadingAnalysis: "munhae:research:getReadingAnalysis",
  researchLatestReadingAnalysis: "munhae:research:latestReadingAnalysis",
  researchCancelReadingAnalysis: "munhae:research:cancelReadingAnalysis",
  researchApplyReadingAnalysis: "munhae:research:applyReadingAnalysis",
  researchStartFootnoteAnalysis: "munhae:research:startFootnoteAnalysis",
  researchGetFootnoteAnalysis: "munhae:research:getFootnoteAnalysis",
  researchCancelFootnoteAnalysis: "munhae:research:cancelFootnoteAnalysis",

  dictionarySearch: "munhae:dictionary:search",
  dictionaryGetStatus: "munhae:dictionary:getStatus",
  dictionarySetKey: "munhae:dictionary:setKey",

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
  alignment?: { agentId: AgentProbe["agentId"]; model: string; reasoning: string | null; serviceTier: string | null } | null;
  language: "ko" | "en";
  translationLanguage: "ko" | "en";
  agentId: "codex" | "claude" | "antigravity";
  agentModels: {
    codex: { model: string; reasoning: string | null; serviceTier: string | null };
    antigravity: { model: string; reasoning: string | null; serviceTier: string | null };
    claude: { model: string; reasoning: string | null; serviceTier: string | null };
  };
  showWelcomeOnLaunch: boolean;
  backgroundMusicEnabled: boolean;
  backgroundMusicVolume: number;
  notificationSoundEnabled: boolean;
  notificationSoundVolume: number;
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
  /** Local path, or a stable online://account/project identifier (never the cache path). */
  packagePath: string;
  openedAt: string;
} & ({ storageMode: "local" } | { storageMode: "online"; onlineProjectId: string; accountId: string });

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
  authorName: string | null;
  language: string | null;
  periodText: string | null;
  dateText: string | null;
  descriptionMd: string | null;
  sourceReference: string | null;
  lockVersion: number;
  updatedAt: string;
};

export type MoveDocumentInput = {
  documentNodeId: string;
  parentId: string;
  beforeDocumentNodeId: string | null;
  expectedLockVersion: number;
};

export type UpdateDocumentMetadataInput = {
  documentNodeId: string;
  title: string;
  originalTitle: string | null;
  authorName: string | null;
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

export type ConcordanceInput = { query: string; scope?: "all" | "source" | "translation"; state?: "current" | "confirmed"; limit?: number; documentNodeId?: string | null };
export type ConcordanceResult = { id: string; documentNodeId: string; documentTitle: string; sourceVersionId: string; sourceVersionNo: number; translationVersionId: string | null; translationVersionNo: number | null; translationState: string | null; isCurrent: boolean; isConfirmed: boolean; sourceIsCurrent: boolean; contextKind: "sentence" | "document"; alignment: "human" | "auto" | "unlinked"; needsReview: boolean; sentenceId: string | null; sourceText: string; translationText: string | null; matchedIn: Array<"source" | "translation"> };
export type ConcordanceView = { query: string; scope: "all" | "source" | "translation"; state: "current" | "confirmed"; results: ConcordanceResult[]; hasMore: boolean };
export type ReviewExportInput = { format: "html" | "markdown"; state: "current" | "confirmed"; documentNodeId?: string | null; includeComments?: boolean };
export type ReviewExportSaveResult = { filePath: string; format: "html" | "markdown"; documentCount: number };

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
      links: Array<{ sentenceId: string; groupId?: string; spans: Array<{ from: number; to: number; quote: string }>; needsReview: boolean; reviewedBy?: "human" }>;
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
  expectedLockVersion: number;
};

export type ConfirmPunctuationInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type SaveTranslationDraftInput = {
  textGroups?: Array<{ id: string; text: string; spans: Array<{ from: number; to: number; quote: string }> }>;

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
export type SaveSentenceLinkInput = {
  documentNodeId: string;
  versionId: string;
  sentenceId: string;
  spans: Array<{ from: number; to: number; quote: string }>;
  expectedLockVersion: number;
};
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

export type UpsertGlossaryInput = Omit<GlossaryEntryView, "id" | "contentHash" | "lockVersion"> & {
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
  inheritToChildren?: boolean;
  conditionMd?: string;
  origin?: MaterialOrigin | null;
  reference?: { commentId: string; needsReview: boolean; sourceChanged: boolean; sourceUnavailable: boolean; reviewedCommentLockVersion: number };
  id: string;
  source: "context_item" | "document_description" | "comment_reference";
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
  inheritToChildren?: boolean;
  conditionMd?: string;
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
  referenceCommentIds?: string[];
};

export type StartTranslationInput = {
  alignmentVersionId?: string;
  documentNodeId: string;
  selections?: Array<{ id: string; mode: "auto" | "pin" | "exclude" }>;
  revision?: TranslationRevisionInput;
  referenceCommentIds?: string[];
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

export type AiCompletionStage = "chat" | "translation" | "alignment" | "punctuation";

export type ChatActivityBlock = { kind: "text" | "thinking" | "tool"; text: string; id?: string; name?: string; state?: "started" | "completed" | "failed" };

export type AiRunView = {
  /** Ordered, display-only activity for this run. */
  activity?: ChatActivityBlock[];
  /** Ephemeral successful-stage signal; never persisted or returned by polling. */
  completionStage?: AiCompletionStage;
  messageId: string;
  documentNodeId: string;
  chatScopeKind?: ChatScopeKind;
  agentId: AgentProbe["agentId"];
  taskKind: "translation" | "chat" | "punctuation_suggest";
  state: "running" | "completed" | "failed" | "canceled";
  phase: string;
  detail: string | null;
  partialText: string;
  /** Provider-visible reasoning; display only, never part of the validated answer. */
  thinkingText?: string;
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

export type SearchEntityType = "glossary";
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

export type ItkcFootnoteSearchInput = {
  query: string;
  mode: "target" | "content";
  start?: number;
};

export type FootnoteAnalysisInput = {
  documentNodeId: string;
  expectedSourceVersionId: string;
  expectedTranslationVersionId: string | null;
  query: string;
  mode: "target" | "content";
  selection?: { targetKind: "source" | "translation"; from: number; to: number; quote: string };
};

export type FootnoteRecommendation = {
  note: ItkcFootnote;
  relevance: "direct" | "contextual";
  reason: string;
  translationAdvice: string;
  caution: string;
  evidenceQuote: string;
};

export type FootnoteAnalysisResult = {
  summary: string;
  recommendations: FootnoteRecommendation[];
  analyzedCount: number;
  total: number;
  omittedCount: number;
  excerptedCount: number;
  sourceContext: string;
  translationContext: string;
  limitations: string[];
};

export type MaterialRefinementInput = { scopeId: string; title: string; contentMd: string; instruction: string; mode?: "refine" | "chat"; draftMd?: string; conversation?: Array<{ role: "user" | "assistant"; content: string }> };
export type MaterialRefinementRun = { activity?: ChatActivityBlock[]; thinkingText?: string; id: string; state: "running" | "completed" | "failed" | "canceled"; result: { contentMd: string; notes: string } | null; error: { code: string; message: string } | null };

export type FootnoteAnalysisRun = {
  id: string;
  documentNodeId: string;
  sourceVersionId: string;
  translationVersionId: string | null;
  agentId: AppConfig["agentId"];
  query: string;
  mode: "target" | "content";
  state: "collecting" | "analyzing" | "completed" | "failed" | "canceled";
  detail: string;
  collectedCount: number;
  total: number | null;
  result: FootnoteAnalysisResult | null;
  error: { code: string; message: string } | null;
};

export type ItkcFootnote = {
  id: string;
  annotatedText: string;
  displayTitle: string;
  bodyText: string;
  bookTitle: string;
  translator: string;
  publisher: string;
  year: string;
  sourceUrl: string;
};

export type ItkcFootnoteSearchResult = {
  query: string;
  mode: "target" | "content";
  searchMode: "annotated-text" | "all-text";
  total: number;
  start: number;
  pageSize: 10;
  hasMore: boolean;
  items: ItkcFootnote[];
};

export type MunhaeApi = {
  billing: {
    getStatus(): Promise<IpcResult<BillingStatus>>;
    openCheckout(): Promise<IpcResult<void>>;
    openPortal(): Promise<IpcResult<void>>;
  };
  dictionary: {
    search(input: DictionarySearchInput): Promise<IpcResult<DictionarySearchResult>>;
    getStatus(): Promise<IpcResult<DictionaryStatus>>;
    setKey(input: DictionarySetKeyInput): Promise<IpcResult<DictionaryStatus>>;
  };
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
    checkUpdates(): Promise<void>;
    openExternal(url: string): Promise<void>;
    copyText(text: string): Promise<void>;
    openChatSource(url: string): Promise<void>;
    onCommand(handler: (id: string) => void): () => void;
  };
  onlineProjects: {
    sharing(id: string): Promise<IpcResult<ProjectSharing>>;
    invitations(): Promise<IpcResult<ProjectInvitation[]>>;
    invite(input: InviteProjectMemberInput): Promise<IpcResult<string>>;
    respond(input: { invitationId: string; accept: boolean }): Promise<IpcResult<string>>;
    cancelInvitation(id: string): Promise<IpcResult<void>>;
    updateMember(input: UpdateProjectMemberInput): Promise<IpcResult<void>>;
    open(input: OpenOnlineProjectInput): Promise<IpcResult<ProjectSummary | null>>;
    status(): Promise<IpcResult<OnlineWorkspaceStatus | null>>;
    sync(): Promise<IpcResult<OnlineWorkspaceStatus | null>>;
    exportRecovery(id: string): Promise<IpcResult<string | null>>;
    create(input: CreateOnlineProjectInput): Promise<IpcResult<OnlineProject>>;
    list(): Promise<IpcResult<OnlineProject[]>>;
    get(id: string): Promise<IpcResult<OnlineProject>>;
  };
  project: {
    onChanged(handler: (event: ProjectChangeEvent) => void): () => void;
    create(input: CreateProjectInput): Promise<IpcResult<ProjectSummary>>;
    open(packagePath?: string): Promise<IpcResult<ProjectSummary | null>>;
    close(): Promise<IpcResult<void>>;
    getCurrent(): Promise<ProjectSummary | null>;
    listRecent(): Promise<RecentProject[]>;
    backup(): Promise<IpcResult<string | null>>;
    concordance(input: ConcordanceInput): Promise<IpcResult<ConcordanceView>>;
    exportReview(input: ReviewExportInput): Promise<IpcResult<ReviewExportSaveResult | null>>;
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
    moveDocument(input: MoveDocumentInput): Promise<IpcResult<DocumentMetadataView>>;
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
    saveSentenceLink(input: SaveSentenceLinkInput): Promise<IpcResult<EditorView>>;
    createReviewComment(input: CreateReviewCommentInput): Promise<IpcResult<ReviewCommentView>>;
    updateReviewComment(input: UpdateReviewCommentInput): Promise<IpcResult<ReviewCommentView>>;
    archiveReviewComment(input: ArchiveReviewCommentInput): Promise<IpcResult<void>>;
    listReadingAnnotations(documentNodeId: string): Promise<IpcResult<ReadingAnnotationView[]>>;
    saveReadingAnnotation(input: SaveReadingAnnotationInput): Promise<IpcResult<ReadingAnnotationView>>;
    archiveReadingAnnotation(input: ReadingAnnotationCasInput): Promise<IpcResult<void>>;
    attachReference(documentNodeId: string): Promise<IpcResult<EditorView | null>>;
    readReference(documentNodeId: string, assetId: string): Promise<IpcResult<ReferenceAssetContent>>;
    openReference(documentNodeId: string, assetId: string): Promise<IpcResult<void>>;
  };
  terms: {
    list(documentId?: string): Promise<IpcResult<TermEntry[]>>;
    delete(input: { id: string; expectedLockVersion: number }): Promise<IpcResult<void>>;
    save(input: SaveTermInput): Promise<IpcResult<TermEntry>>;
    promote(input: SaveTermInput): Promise<IpcResult<TermEntry>>;
    start(documentId: string, excludedMaterialIds?: string[], glossarySelection?: TermGlossarySelection): Promise<IpcResult<TermExtractionRun>>;
    getRun(id: string): Promise<IpcResult<TermExtractionRun>>;
    latestRun(documentId: string): Promise<IpcResult<TermExtractionRun | null>>;
    cancel(id: string): Promise<IpcResult<TermExtractionRun>>;
  };
  knowledge: {
    getMaterials(documentNodeId?: string): Promise<IpcResult<MaterialsView>>;
    setMaterialPreference(input: SetMaterialPreferenceInput): Promise<IpcResult<void>>;
    reuseCommentAsMaterial(input: ReuseCommentAsMaterialInput): Promise<IpcResult<NodeContextView>>;
    get(): Promise<IpcResult<KnowledgeView>>;
    upsertGlossary(entry: UpsertGlossaryInput): Promise<IpcResult<GlossaryEntryView>>;
    createContext(input: CreateContextItemInput): Promise<IpcResult<NodeContextView>>;
    updateContext(input: UpdateContextItemInput): Promise<IpcResult<NodeContextView>>;
    setContextEnabled(input: SetContextItemEnabledInput): Promise<IpcResult<NodeContextView>>;
    setContextPriority(input: SetContextItemPriorityInput): Promise<IpcResult<NodeContextView>>;
    deleteContext(input: ContextItemCasInput): Promise<IpcResult<void>>;
    createUncertainty(input: CreateUncertaintyInput): Promise<IpcResult<UncertaintyView>>;
    versionUncertainty(input: CreateUncertaintyVersionInput): Promise<IpcResult<UncertaintyView>>;
    resolveUncertainty(input: ResolveUncertaintyInput): Promise<IpcResult<UncertaintyView>>;
  };
  context: {
    preview(input: ContextPreviewInput): Promise<IpcResult<ContextPreview>>;
  };
  research: ReadingAnalysisApi & {
    startMaterialRefinement(input: MaterialRefinementInput): Promise<IpcResult<MaterialRefinementRun>>;
    getMaterialRefinement(id: string): Promise<IpcResult<MaterialRefinementRun>>;
    cancelMaterialRefinement(id: string): Promise<IpcResult<MaterialRefinementRun>>;
    searchFootnotes(input: ItkcFootnoteSearchInput): Promise<IpcResult<ItkcFootnoteSearchResult>>;
    startFootnoteAnalysis(input: FootnoteAnalysisInput): Promise<IpcResult<FootnoteAnalysisRun>>;
    getFootnoteAnalysis(id: string): Promise<IpcResult<FootnoteAnalysisRun>>;
    cancelFootnoteAnalysis(id: string): Promise<IpcResult<FootnoteAnalysisRun>>;
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
  alignment: null,
  language: "ko",
  translationLanguage: "ko",
  agentId: "claude",
  agentModels: {
    codex: { model: "default", reasoning: "medium", serviceTier: null },
    antigravity: { model: "default", reasoning: null, serviceTier: null },
    claude: { model: "default", reasoning: null, serviceTier: null },
  },
  showWelcomeOnLaunch: true,
  backgroundMusicEnabled: true,
  backgroundMusicVolume: 18,
  notificationSoundEnabled: true,
  notificationSoundVolume: 35,
};
