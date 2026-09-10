import type { DocumentListItem } from "../../shared/munhae-api";

export const HOME_STAGES = [
  { key: "source", label: "원문" },
  { key: "punctuation", label: "표점" },
  { key: "translation", label: "번역안" },
  { key: "review", label: "재검토" },
  { key: "confirmed", label: "확정" },
] as const;

export type HomeStage = (typeof HOME_STAGES)[number]["key"];

export type HomeGroup = {
  id: string;
  title: string;
  containerId: string | null;
  documents: DocumentListItem[];
};

type RecentDocument = { title: string };

function isSource(document: DocumentListItem): boolean {
  return document.nodeRole === "source_unit" && !document.isMaster;
}

function titleOf(document: DocumentListItem): string {
  return document.originalTitle || document.title;
}

export function homeStage(document: DocumentListItem): HomeStage {
  if ([document.sourceState, document.punctuationState, document.translationState].includes("review")) {
    return "review";
  }
  if (document.translationState === "confirmed") return "confirmed";
  if (document.translationState === "draft") return "translation";
  if (document.punctuationState === "draft" || document.punctuationState === "confirmed") return "punctuation";
  return "source";
}

/** Each original document ID appears at most once, preserving the supplied order. */
function documentIndex(documents: readonly DocumentListItem[]): Map<string, DocumentListItem> {
  const index = new Map<string, DocumentListItem>();
  for (const document of documents) {
    if (!index.has(document.id)) index.set(document.id, document);
  }
  return index;
}

export function buildHomeGroups(documents: readonly DocumentListItem[]): HomeGroup[] {
  const index = documentIndex(documents);
  const order = new Map([...index.keys()].map((id, position) => [id, position]));
  const groups = new Map<string, HomeGroup>();

  // Follow actual links, not depth: imported trees can contain missing ancestors.
  function groupContainer(document: DocumentListItem): DocumentListItem | null {
    const ancestors: DocumentListItem[] = [];
    const visited = new Map<string, number>();
    let cursor: DocumentListItem | undefined = document;
    let container: DocumentListItem | null = null;
    while (cursor && !cursor.isMaster) {
      const previous = visited.get(cursor.id);
      if (previous !== undefined) {
        // All entries into the same cycle must choose the same group root.
        const cycleContainers = ancestors.slice(previous).filter(item => item.nodeRole === "container");
        return cycleContainers.reduce<DocumentListItem | null>((first, item) => {
          return !first || order.get(item.id)! < order.get(first.id)! ? item : first;
        }, container);
      }
      visited.set(cursor.id, ancestors.length);
      ancestors.push(cursor);
      if (cursor.nodeRole === "container") container = cursor;
      cursor = cursor.parentId ? index.get(cursor.parentId) : undefined;
    }
    return container;
  }

  // Include top-level folders even when they contain no source documents yet.
  for (const document of index.values()) {
    if (document.nodeRole !== "container" || document.isMaster) continue;
    const container = groupContainer(document);
    if (!container || groups.has(container.id)) continue;
    groups.set(container.id, {
      id: container.id,
      title: titleOf(container),
      containerId: container.id,
      documents: [],
    });
  }

  const direct: DocumentListItem[] = [];
  for (const document of index.values()) {
    if (!isSource(document)) continue;
    const container = groupContainer(document);
    const group = container ? groups.get(container.id) : undefined;
    if (group) group.documents.push(document);
    else direct.push(document);
  }
  const result = [...groups.values()];
  if (direct.length) {
    result.push({
      id: "home-direct-sources",
      title: result.length ? "직접 연결된 원문" : "원문 문서",
      containerId: null,
      documents: direct,
    });
  }
  return result;
}

export function homeDocumentPath(document: DocumentListItem, documents: readonly DocumentListItem[]): string {
  const index = documentIndex(documents);
  const visited = new Set([document.id]);
  const titles: string[] = [];
  let parentId = document.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = index.get(parentId);
    if (!parent || parent.isMaster) break;
    titles.unshift(titleOf(parent));
    parentId = parent.parentId;
  }
  return titles.join(" › ");
}

export function resolveRecentDocument(recent: RecentDocument, documents: readonly DocumentListItem[]): DocumentListItem | null {
  if (!recent.title.trim()) return null;
  const matches = [...documentIndex(documents).values()].filter(document =>
    isSource(document) && document.title === recent.title,
  );
  // Recent activity supplies n.title. Original-title matches can point at a different source.
  // A title-only event also cannot distinguish identically named sources in different chapters.
  return matches.length === 1 ? matches[0]! : null;
}

export function resolveHomeResume(
  documents: readonly DocumentListItem[],
  persistedId: string | null | undefined,
  recent: readonly RecentDocument[],
): { document: DocumentListItem | null; kind: "resume" | "recent" | "first" } {
  const currentSources = [...documentIndex(documents).values()].filter(isSource);
  const persisted = persistedId ? currentSources.find(document => document.id === persistedId) : undefined;
  if (persisted) return { document: persisted, kind: "resume" };
  for (const event of recent) {
    const document = resolveRecentDocument(event, currentSources);
    if (document) return { document, kind: "recent" };
  }
  return { document: currentSources[0] ?? null, kind: "first" };
}

export function resolveHomeCreationParent(
  documents: readonly DocumentListItem[],
  selection: {
    explicitParentId?: string | null;
    containerId?: string | null;
    groupId?: string | null;
    selectedId?: string | null;
  },
): string | null {
  // Explicit caller intent, including the project root, must not be silently redirected.
  if (selection.explicitParentId !== undefined) return selection.explicitParentId;

  const index = documentIndex(documents);
  const masterId = [...index.values()].find(document => document.isMaster && document.nodeRole === "container")?.id ?? null;
  const containerId = (id: string | null | undefined): string | null => {
    const document = id ? index.get(id) : undefined;
    return document?.nodeRole === "container" ? document.id : null;
  };

  const currentContainer = containerId(selection.containerId);
  if (currentContainer) return currentContainer;

  if (selection.groupId) {
    const group = buildHomeGroups(documents).find(item => item.id === selection.groupId);
    if (group) return group.containerId ?? masterId;
  }

  const selected = selection.selectedId ? index.get(selection.selectedId) : undefined;
  if (selected?.nodeRole === "container") return selected.id;
  if (selected && isSource(selected)) return containerId(selected.parentId) ?? masterId;
  return masterId;
}
