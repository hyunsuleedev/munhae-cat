import { t, ui } from "./i18n";
import type { DocumentListItem } from "../../shared/munhae-api";

/** Each stage also has a one-glyph proof mark for the contents lines. */
export const HOME_STAGES = [
  { key: "source", label: t("원문"), mark: "原" },
  { key: "punctuation", label: t("표점"), mark: "點" },
  { key: "translation", label: t("번역안"), mark: "譯" },
  { key: "review", label: t("재검토"), mark: "覆" },
  { key: "confirmed", label: t("확정"), mark: "定" },
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
      title: result.length ? t("직접 연결된 원문") : t("원문 문서"),
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

export type HomeSection =
  | { kind: "group"; group: HomeGroup }
  | { kind: "loose"; documents: DocumentListItem[] };

/** Chapter groups and directly attached sources, in the order the project tree lists them. */
export function buildHomeSections(documents: readonly DocumentListItem[]): HomeSection[] {
  const position = new Map<string, number>();
  documents.forEach((document, index) => { if (!position.has(document.id)) position.set(document.id, index); });
  const items: Array<{ at: number; group?: HomeGroup; document?: DocumentListItem }> = [];
  for (const group of buildHomeGroups(documents)) {
    if (group.containerId) items.push({ at: position.get(group.containerId) ?? 0, group });
    else for (const document of group.documents) items.push({ at: position.get(document.id) ?? 0, document });
  }
  items.sort((a, b) => a.at - b.at);
  const sections: HomeSection[] = [];
  for (const item of items) {
    if (item.group) { sections.push({ kind: "group", group: item.group }); continue; }
    const last = sections.at(-1);
    if (last?.kind === "loose") last.documents.push(item.document!);
    else sections.push({ kind: "loose", documents: [item.document!] });
  }
  return sections;
}

/** Short activity time: "14:32" today, "어제 21:40", "3일 전" within a week, then the date. */
export function homeWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return ui`어제 ${time}`;
  if (days < 7) return ui`${days}일 전`;
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`;
  return ui`${date.getMonth() + 1}월 ${date.getDate()}일`;
}
