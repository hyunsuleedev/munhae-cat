import type { TranslationNote } from "./translation-notes.ts";
import type { ProjectTermListItem } from "./term-review.ts";
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


export type DocumentNodeRole = "container" | "source_unit";


export type SourceOriginKind = "manual" | "paste" | "import";

export type PunctuationStructureMode = "prose" | "poetry";

/** Includes clause spans stored by legacy projects; new spans are validated by structure mode. */
export type PunctuationSpanKind = "paragraph" | "sentence" | "verse_line" | "couplet" | "stanza" | "clause";

export type PunctuationStructureSpanInput = {
  spanKey: string;
  spanKind: PunctuationSpanKind;
  parentSpanKey?: string | null;
  ordinal: number;
  codepointFrom: number;
  codepointTo: number;
  label?: string | null;
};

export type PunctuationStructureSpanView = {
  id: string;
  spanKind: PunctuationSpanKind;
  parentSpanId: string | null;
  ordinal: number;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  label: string | null;
};

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
  contextCount: number;
};

export type HomeView = {
  project: ProjectSummary;
  documents: DocumentListItem[];
  progress: {
    sourceConfirmed: number;
    punctuationConfirmed: number;
    translationDraft: number;
    translationConfirmed: number;
    total: number;
  };
  recent: Array<{ title: string; summary: string; when: string; tag: string }>;
  /** One entry per source unit. */
  activity: Array<{
    documentId: string;
    translationVersion: number | null;
    /** Latest source, punctuation, translation, or review comment change. */
    lastActivityAt: string | null;
    commentCount: number;
    /** Newest first, at most two. */
    recentComments: Array<{ id: string; quote: string; bodyMd: string; updatedAt: string }>;
  }>;
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

/** What deleting a node hides: the node and its descendants, and what is attached only to them. */
export type DocumentDeletionView = {
  documentNodeId: string;
  /** The node first, then every descendant. */
  documentIds: string[];
  /** Project terms confirmed only in these documents. */
  termCount: number;
  commentCount: number;
  lockVersion: number;
};

export type DeleteDocumentInput = {
  documentNodeId: string;
  expectedLockVersion: number;
  /** Also delete the terms used only in these documents and the documents' review comments. */
  removeTermsAndComments: boolean;
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

export type ReferenceAssetState = "present" | "missing" | "unsafe_path" | "size_mismatch" | "hash_mismatch";

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
  state: ReferenceAssetState;
  verifiedAt: string;
};

export type ReferenceAssetContent = {
  assetId: string;
  mimeType: string;
  base64: string;
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
    lockVersion: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    contentText: string;
  };
  punctuation: {
    versionId: string;
    versionNo: number;
    lockVersion: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    punctuatedText: string;
    structureMode: PunctuationStructureMode;
    structureSpans: PunctuationStructureSpanView[];
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
      storageRevision?: string;
      state: "pending" | "running" | "ready" | "needs_review" | "failed";
      sentences: Array<{ id: string; from: number; to: number; text: string }>;
      links: Array<{ sentenceId: string; groupId?: string; spans: Array<{ from: number; to: number; quote: string }>; needsReview: boolean; reviewedBy?: "human" }>;
      error: string | null;
    };
    originKind: string;
    /** True only when this immutable version targets the editor's current source, punctuation, and anchor set. */
    isCurrentDependencies: boolean;
    lockVersion: number;
    blocks: TranslationBlockView[];
    /** Footnotes of this exact version, numbered by position; unplaced notes come last. */
    notes?: TranslationNote[];
  } | null;
  chat: Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    meta?: string;
  }>;
};

export type SaveTranslationDraftInput = {
  textBaseVersionId?: string;
  textBaseRevision?: string;
  textGroups?: Array<{ id: string; from?: number; to?: number; text: string; spans: Array<{ from: number; to: number; quote: string }> }>;

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

export type ResetTranslationDraftInput = {
  fullText?: boolean;
  documentNodeId: string;
  expectedSourceLockVersion: number;
  expectedPunctuationLockVersion: number;
  expectedTranslationLockVersion: number;
};

export type ReviseTranslationInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type SaveSourceDraftInput = {
  documentNodeId: string;
  contentText: string;
  originKind: SourceOriginKind;
  expectedLockVersion: number;
};

export type ConfirmSourceInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type CreatePunctuationDraftInput = {
  documentNodeId: string;
  structureMode: PunctuationStructureMode;
  expectedSourceLockVersion: number;
};

export type SavePunctuationDraftInput = {
  documentNodeId: string;
  punctuatedText: string;
  structureMode: PunctuationStructureMode;
  structureSpans?: PunctuationStructureSpanInput[];
  expectedLockVersion: number;
};

export type ConfirmPunctuationInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type ConfirmTranslationInput = {
  documentNodeId: string;
  expectedLockVersion: number;
};

export type MergeBlocksInput = {
  documentNodeId: string;
  leftBlockKey: string;
  rightBlockKey: string;
  expectedLockVersion: number;
};

export type SplitBlockInput = {
  documentNodeId: string;
  blockKey: string;
  /** Unicode code-point offset inside the selected translation block. */
  splitAt: number;
  /** Boundary in sourceAnchorIds (1..length-1) for a multi-anchor block. */
  anchorSplitAt?: number;
  expectedLockVersion: number;
};

export type NodeContextView = {
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
  inheritToChildren?: boolean;
  conditionMd?: string;
  origin?: MaterialOrigin | null;
  reference?: { commentId: string; needsReview: boolean; sourceChanged: boolean; sourceUnavailable: boolean; reviewedCommentLockVersion: number };
};

export type MaterialOrigin = {
  commentId: string;
  documentNodeId: string;
  translationVersionId: string;
  targetKind: "source" | "translation";
  targetVersionId: string;
  codepointFrom: number;
  codepointTo: number;
  quote: string;
  bodyMd: string;
  lockVersion: number;
};

export type MaterialCommentView = ReviewCommentView & { authorName: string; materialIds: string[] };
export type MaterialPreferenceView = {
  documentNodeId: string;
  source: "context_item" | "document_description" | "comment_reference";
  /** Actual context_items.id or document_nodes.id, never a virtual display ID. */
  sourceId: string;
  mode: "include" | "exclude";
  referenced: boolean;
  excluded: boolean;
  lockVersion: number;
};
export type ResolvedMaterialView = NodeContextView & {
  reason: "current" | "ancestor" | "selected";
  excluded: boolean;
  referenced: boolean;
  included: boolean;
};
export type MaterialsView = {
  items: NodeContextView[];
  comments: MaterialCommentView[];
  preferences: MaterialPreferenceView[];
  documentNodeId?: string;
  resolved?: ResolvedMaterialView[];
};
export type SetMaterialPreferenceInput = {
  documentNodeId: string;
  source: MaterialPreferenceView["source"];
  sourceId: string;
  mode: "include" | "exclude" | "reset";
  expectedLockVersion?: number;
};
export type ReuseCommentAsMaterialInput = CreateContextItemInput & {
  commentId: string;
  expectedCommentLockVersion: number;
};

export type CreateContextItemInput = {
  scopeId: string;
  title: string;
  contentMd: string;
  priority: number;
  enabled: boolean;
  inheritToChildren?: boolean;
  conditionMd?: string;
};

export type UpdateContextItemInput = CreateContextItemInput & {
  expectedCommentLockVersion?: number;
  keepAsContext?: boolean;
  id: string;
  expectedLockVersion: number;
};

export type ContextItemCasInput = {
  id: string;
  expectedLockVersion: number;
};

export type SetContextItemEnabledInput = ContextItemCasInput & { enabled: boolean };
export type SetContextItemPriorityInput = ContextItemCasInput & { priority: number };

export type KnowledgeView = {
  /** Project terms, each confirmed in at least one document. */
  terms: ProjectTermListItem[];
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
    /** Exact user-visible payload represented by hash/chars. */
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
    /** Exact candidate payload, including when the item is excluded. */
    content: string;
    material?: { scopeId: string; inheritToChildren: boolean; lockVersion: number; origin: MaterialOrigin | null };
  }>;
  status: "ready";
  manifestJson: string;
  snapshot: TranslationRunSnapshot;
};

export type ContextPreviewInput = {
  documentNodeId: string;
  selections?: Array<{ id: string; mode: "auto" | "pin" | "exclude" }>;
  revision?: { baseVersionId: string; commentIds: string[] };
  referenceCommentIds?: string[];
};

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
export type ReviewCommentCasInput = { id: string; expectedLockVersion: number };
export type UpdateReviewCommentInput = ReviewCommentCasInput & { bodyMd: string };

export type TranslationHeadSnapshot = {
  translationId: string;
  currentVersionId: string;
  lockVersion: number;
} | null;

export type TranslationRunSnapshot = {
  documentNodeId: string;
  sourceTextId: string;
  sourceTextVersionId: string;
  punctuationVersionId: string;
  policyVersionId: string;
  anchorSetId: string;
  targetLocale: string;
  expectedHead: TranslationHeadSnapshot;
};

export type BeginTranslationRunInput = ContextPreviewInput & {
  agentId: "codex" | "claude" | "antigravity";
  requestedModel: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  runtimeVersion: string | null;
};

export type PreparedTranslationRun = {
  messageId: string;
  threadId: string;
  requestArtifactId: string;
  requestText: string;
  requestHash: string;
  promptContractVersion: string;
  snapshot: TranslationRunSnapshot;
};

export type CompleteTranslationRunInput = {
  messageId: string;
  rawResponse: string;
  eventsJsonl: string;
  usage: unknown;
  resolvedModel: string | null;
  runtimeVersion: string | null;
};

export type CompletedTranslationRun = {
  messageId: string;
  validationState: "valid" | "invalid_unapplied";
  fatalFindings: number;
  recoverableFindings: number;
  version: {
    translationId: string;
    versionId: string;
    validationState: "valid";
  } | null;
  idempotent: boolean;
};

export type ChatScopeKind = "document_node" | "project";

export type GetProjectChatInput = {
  documentNodeId: string;
  scopeKind: ChatScopeKind;
};

export type BeginProjectChatRunInput = GetProjectChatInput & {
  question: string;
  agentId: "codex" | "claude" | "antigravity";
  requestedModel: string;
  reasoningLevel: string | null;
  serviceTier: string | null;
  runtimeVersion: string | null;
};

export type BeginPunctuationSuggestionRunInput = {
  documentNodeId: string;
  structureMode: PunctuationStructureMode;
  agentId: "codex" | "claude" | "antigravity";
  requestedModel: string;
  reasoningLevel: string | null;
  serviceTier: string | null;
  runtimeVersion: string | null;
};

export type PreparedProjectTaskRun = {
  messageId: string;
  threadId: string;
  requestArtifactId: string;
  requestText: string;
  requestHash: string;
  promptContractVersion: string;
  stablePromptHash: string;
  requestedModel: string;
  resumeCompatible: boolean;
};

export type CompleteProjectTaskRunInput = {
  messageId: string;
  rawResponse: string;
  eventsJsonl: string;
  usage: unknown;
  resolvedModel: string | null;
  runtimeVersion: string | null;
};

export type CompletedPunctuationSuggestionRun = {
  messageId: string;
  validationState: "valid" | "invalid_unapplied";
  applied: boolean;
  punctuationVersionId: string | null;
  anchorSetId: string | null;
};

export type PunctuationSuggestionView = CompletedPunctuationSuggestionRun & {
  validationError: string | null;
  documentNodeId: string;
  agentId: "codex" | "claude" | "antigravity";
  responseText: string;
  createdAt: string;
};
