export type AgentProbe = {
  agentId: "codex" | "claude";
  installed: boolean;
  loggedIn: boolean | null;
  version: string | null;
  lastCheckedAt: string;
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

export type DocumentKind = "collection" | "work" | "volume" | "chapter" | "section" | "item";

export type DocumentNodeRole = "container" | "source_unit";

export type DocumentGenre =
  | "poetry"
  | "letter"
  | "memorial"
  | "preface"
  | "epitaph"
  | "biography"
  | "official_document"
  | "prose"
  | "other";

export type VersionUiState = "draft" | "confirmed" | "review" | "none";

export type DocumentListItem = {
  id: string;
  parentId: string | null;
  depth: number;
  nodeRole: DocumentNodeRole;
  isMaster: boolean;
  structuralKind: DocumentKind;
  genre: DocumentGenre | null;
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
  progress: {
    sourceConfirmed: number;
    punctuationConfirmed: number;
    translationDraft: number;
    translationConfirmed: number;
    total: number;
  };
  uncertainties: Array<{ id: string; label: string; category: string; locator: string }>;
  recent: Array<{ title: string; summary: string; when: string; tag: string }>;
  agents: AgentProbe[];
};

type CreateDocumentBaseInput = {
  title: string;
  originalTitle?: string | null;
  parentId: string | null;
  structuralKind: DocumentKind;
  genre: DocumentGenre;
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

export type TranslationBlockView = {
  blockKey: string;
  ordinal: number;
  blockKind: string;
  translation: string;
  sourceAnchorIds: string[];
  relationKinds: string[];
};

export type EditorView = {
  project: ProjectSummary;
  document: {
    id: string;
    title: string;
    originalTitle: string | null;
    nodeRole: DocumentNodeRole;
    structuralKind: DocumentKind;
    genre: DocumentGenre | null;
    authorName: string | null;
    periodText: string | null;
    language: string | null;
    sourceReference: string | null;
  };
  source: {
    versionId: string;
    versionNo: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    contentText: string;
  };
  punctuation: {
    versionId: string;
    versionNo: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    punctuatedText: string;
  };
  anchors: Array<{
    anchorKey: string;
    ordinal: number;
    boundaryKind: string;
    punctuationFrom: number;
    punctuationTo: number;
    punctuatedQuote: string;
  }>;
  candidates: Array<{
    stage: string;
    candidateKey: string;
    versionId: string;
    versionNo: number;
    state: "draft" | "confirmed" | "rejected" | "superseded";
    validationState: "valid" | "needs_review";
    textContent: string;
    originKind: string;
    isCurrent: boolean;
    isConfirmed: boolean;
    blocks: TranslationBlockView[];
  }>;
  activeStage: string;
  lockVersion: number;
  reflection: {
    summary: string;
    findings: Array<{
      findingKind: string;
      severity: string;
      message: string;
      sourceAnchorIds: string[];
      candidateKey: string | null;
    }>;
  } | null;
  chat: Array<{
    role: "user" | "assistant";
    text: string;
    createdAt: string;
    meta?: string;
  }>;
};

export type SaveTranslationDraftInput = {
  documentNodeId: string;
  stage: string;
  textContent: string;
  blocks: Array<{
    blockKey: string;
    blockKind: string;
    translation: string;
    sourceAnchorIds: string[];
    relationKinds?: string[];
  }>;
  expectedLockVersion?: number;
};

export type ConfirmTranslationInput = {
  documentNodeId: string;
  stage: string;
  expectedLockVersion: number;
};

export type MergeBlocksInput = {
  documentNodeId: string;
  stage: string;
  leftBlockKey: string;
  rightBlockKey: string;
  expectedLockVersion?: number;
};

export type SplitBlockInput = {
  documentNodeId: string;
  stage: string;
  blockKey: string;
  splitAt: number;
  expectedLockVersion?: number;
};

export type GlossaryEntryView = {
  id: string;
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
  preferredName: string;
  hanjaName: string | null;
  reading: string | null;
  aliases: string[];
  descriptionMd: string | null;
  dateText: string | null;
};

export type PlaceView = {
  id: string;
  preferredName: string;
  hanjaName: string | null;
  reading: string | null;
  aliases: string[];
  placeKind: string | null;
  locationNoteMd: string | null;
  descriptionMd: string | null;
};

export type UncertaintyView = {
  id: string;
  category: "textual" | "interpretive" | "identification";
  severity: string;
  blocking: boolean;
  state: string;
  statementMd: string;
  locator: string;
};

export type NodeContextView = {
  id: string;
  source: "context_item" | "document_description";
  itemKind: string;
  scopeKind: "document_node";
  scopeId: string;
  title: string;
  contentMd: string;
  priority: number;
  enabled: boolean;
  updatedAt: string;
};

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
  required: Array<{ kind: string; label: string; version?: string; hash?: string; chars: number }>;
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
  }>;
  status: "ready";
  manifestJson: string;
};

export type ContextPreviewInput = {
  documentNodeId: string;
  recipe: "two_step" | "three_step";
  selections?: Array<{ id: string; mode: "auto" | "pin" | "exclude" }>;
};
