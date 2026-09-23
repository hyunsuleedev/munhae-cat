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
