import type { DocumentListItem } from "../../shared/munhae-api";

/** Navigation state is scoped to a project package, never shared between projects. */
export type SidebarSnapshot = { expanded: Array<[string, boolean]>; focus: string | null; scroll: number };
export function sidebarStorageKey(project: { projectId: string; packagePath: string }): string {
  return `munhae.sidebar.v1:${JSON.stringify([project.packagePath, project.projectId])}`;
}
export function readSidebarSnapshot(raw: string | null): SidebarSnapshot {
  const fallback: SidebarSnapshot = { expanded: [], focus: null, scroll: 0 };
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || typeof value !== "object") return fallback;
    return {
      expanded: Array.isArray(value.expanded) ? value.expanded.filter((entry: unknown): entry is [string, boolean] =>
        Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "boolean") : [],
      focus: typeof value.focus === "string" ? value.focus : null,
      scroll: typeof value.scroll === "number" && Number.isFinite(value.scroll) ? Math.max(0, value.scroll) : 0,
    };
  } catch { return fallback; }
}

export type SidebarBranch = { id?: string; lbl?: string; searchText?: string; docId?: string; contextFor?: string; kids?: SidebarBranch[] };
/** Keep matching documents and their ancestors; filtering never mutates expansion state. */
export function filterSidebarBranches<T extends SidebarBranch>(nodes: T[], query: string): T[] {
  const terms = query.normalize("NFC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return nodes;
  function visit(items: T[], path: string): T[] {
    return items.flatMap(node => {
      if (node.contextFor) return [];
      const text = `${path} ${node.searchText ?? node.lbl ?? ""}`.normalize("NFC").toLocaleLowerCase();
      const children = visit((node.kids ?? []) as T[], text);
      const match = terms.every(term => text.includes(term));
      return match || children.length ? [{ ...node, kids: children }] : [];
    });
  }
  return visit(nodes, "");
}

export function sidebarAncestors(nodes: SidebarBranch[], key: string): string[] | null {
  for (const node of nodes) {
    if (node.id === key) return [];
    const path = sidebarAncestors(node.kids ?? [], key);
    if (path) return node.id ? [node.id, ...path] : path;
  }
  return null;
}

export type DropZone = "before" | "after" | "into";
type Placeable = Pick<DocumentListItem, "id" | "parentId" | "nodeRole" | "isMaster" | "ordinal">;

/**
 * Which part of a row a drag points at; `y` runs from 0 at the row's top edge to 1 at its bottom.
 * Folders take most drops inside. An expanded folder's lower edge touches its first child, so it takes no drop after it.
 */
export function dropZone(over: Placeable, y: number, expanded: boolean): DropZone {
  if (over.isMaster) return "into";
  if (over.nodeRole === "container") return y < 0.25 ? "before" : y > 0.75 && !expanded ? "after" : "into";
  return y < 0.5 ? "before" : "after";
}

/** The folder and following sibling a dragged node lands at, or null when the drop is not allowed or changes nothing. */
export function dropPlacement(docs: readonly Placeable[], movingId: string, overId: string, zone: DropZone): { parentId: string; beforeId: string | null } | null {
  const byId = new Map(docs.map(doc => [doc.id, doc]));
  const moving = byId.get(movingId), over = byId.get(overId);
  if (!moving || !over || moving.isMaster) return null;
  // Never into the dragged node itself or anywhere in its own branch.
  for (let node: Placeable | undefined = over; node; node = node.parentId ? byId.get(node.parentId) : undefined) if (node.id === moving.id) return null;
  if (zone === "into" ? over.nodeRole !== "container" : over.isMaster) return null;
  const parentId = zone === "into" ? over.id : over.parentId!;
  const siblings = docs.filter(doc => doc.parentId === parentId && doc.id !== moving.id).sort((a, b) => a.ordinal - b.ordinal);
  const beforeId = zone === "into" ? null : zone === "before" ? over.id : siblings[siblings.findIndex(doc => doc.id === over.id) + 1]?.id ?? null;
  if (parentId === moving.parentId && beforeId === (siblings.find(doc => doc.ordinal > moving.ordinal)?.id ?? null)) return null;
  return { parentId, beforeId };
}
