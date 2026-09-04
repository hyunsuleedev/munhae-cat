/**
 * Renderer ↔ preload ↔ main typed IPC contract.
 * Keep this file free of Node/Electron imports so the renderer can import types.
 */

export const IPC_CHANNELS = {
  appGetVersion: "munhae:app:getVersion",
  appGetConfig: "munhae:app:getConfig",
  appSetConfig: "munhae:app:setConfig",
  appProbeAgents: "munhae:app:probeAgents",
  appQuit: "munhae:app:quit",
  appShowAbout: "munhae:app:showAbout",
  appOpenExternal: "munhae:app:openExternal",
  appOpenPath: "munhae:app:openPath",
  menuCommand: "munhae:menu:command",

  projectCreate: "munhae:project:create",
  projectOpen: "munhae:project:open",
  projectClose: "munhae:project:close",
  projectGetCurrent: "munhae:project:getCurrent",
  projectListRecent: "munhae:project:listRecent",
  projectBackup: "munhae:project:backup",
  projectCreateFromPaste: "munhae:project:createFromPaste",
  projectSeedDemo: "munhae:project:seedDemo",

  homeGet: "munhae:home:get",
  documentCreate: "munhae:document:create",
  documentPickText: "munhae:document:pickText",

  editorGet: "munhae:editor:get",
  editorSaveDraft: "munhae:editor:saveDraft",
  editorConfirm: "munhae:editor:confirm",
  editorRevise: "munhae:editor:revise",
  editorMergeBlocks: "munhae:editor:mergeBlocks",
  editorSplitBlock: "munhae:editor:splitBlock",

  knowledgeGet: "munhae:knowledge:get",
  knowledgeUpsertGlossary: "munhae:knowledge:upsertGlossary",
  knowledgeUpsertPerson: "munhae:knowledge:upsertPerson",
  knowledgeUpsertPlace: "munhae:knowledge:upsertPlace",

  contextPreview: "munhae:context:preview",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type AppConfig = {
  agentId: "codex" | "claude";
  agentModels: {
    codex: { model: string; reasoning: string | null; serviceTier: string | null };
    claude: { model: string; reasoning: string | null; serviceTier: string | null };
  };
  showWelcomeOnLaunch: boolean;
};

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

export type CreateProjectInput = {
  title: string;
  parentDir?: string;
};

export type CreateFromPasteInput = {
  title: string;
  sourceText: string;
  parentDir?: string;
};

export type DocumentKind =
  | "collection"
  | "work"
  | "volume"
  | "chapter"
  | "section"
  | "item";

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
  progress: { sourceConfirmed: number; punctuationConfirmed: number; translationDraft: number; translationConfirmed: number; total: number };
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

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

export type MunhaeApi = {
  app: {
    getVersion(): Promise<string>;
    getConfig(): Promise<AppConfig>;
    setConfig(patch: Partial<AppConfig>): Promise<AppConfig>;
    probeAgents(): Promise<AgentProbe[]>;
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
    createFromPaste(input: CreateFromPasteInput): Promise<IpcResult<ProjectSummary>>;
    seedDemo(): Promise<IpcResult<ProjectSummary>>;
  };
  home: {
    get(): Promise<IpcResult<HomeView>>;
    createDocument(input: CreateDocumentInput): Promise<IpcResult<DocumentListItem>>;
    pickTextFile(): Promise<IpcResult<string | null>>;
  };
  editor: {
    get(documentNodeId: string): Promise<IpcResult<EditorView>>;
    saveDraft(input: SaveTranslationDraftInput): Promise<IpcResult<EditorView>>;
    confirm(input: ConfirmTranslationInput): Promise<IpcResult<EditorView>>;
    revise(documentNodeId: string, stage: string): Promise<IpcResult<EditorView>>;
    mergeBlocks(input: MergeBlocksInput): Promise<IpcResult<EditorView>>;
    splitBlock(input: SplitBlockInput): Promise<IpcResult<EditorView>>;
  };
  knowledge: {
    get(): Promise<IpcResult<KnowledgeView>>;
    upsertGlossary(entry: Omit<GlossaryEntryView, "id"> & { id?: string }): Promise<IpcResult<GlossaryEntryView>>;
    upsertPerson(person: Omit<PersonView, "id"> & { id?: string }): Promise<IpcResult<PersonView>>;
    upsertPlace(place: Omit<PlaceView, "id"> & { id?: string }): Promise<IpcResult<PlaceView>>;
  };
  context: {
    preview(input: ContextPreviewInput): Promise<IpcResult<ContextPreview>>;
  };
};

export const DEFAULT_APP_CONFIG: AppConfig = {
  agentId: "claude",
  agentModels: {
    codex: { model: "default", reasoning: "medium", serviceTier: null },
    claude: { model: "default", reasoning: null, serviceTier: null },
  },
  showWelcomeOnLaunch: true,
};
