import type { DocumentListItem, GlossaryEntryView, MaterialPreferenceView, NodeContextView } from "../../shared/munhae-api";

export const KNOWLEDGE_TABS = ["context", "glossary", "comments", "uncertainty"] as const;
export type KnowledgeTab = typeof KNOWLEDGE_TABS[number];

export function knowledgeTabFromHash(hash: string): KnowledgeTab {
  const requested = hash.startsWith("#") ? hash.slice(1) : hash;
  if (requested === "background") return "context";
  // Older bookmarks for the removed person/place editors open the shared context workspace.
  return KNOWLEDGE_TABS.find(tab => tab === requested) ?? "context";
}

export const USAGE_LABELS: Record<GlossaryEntryView["usageStatus"], string> = {
  preferred: "기본",
  allowed: "허용",
  forbidden: "지양",
};

export function documentPath(documents: readonly DocumentListItem[], nodeId: string): DocumentListItem[] {
  const byId = new Map(documents.map(node => [node.id, node]));
  const path: DocumentListItem[] = [];
  const seen = new Set<string>();
  let current: DocumentListItem | undefined = byId.get(nodeId);
  if (!current) return [];
  while (current) {
    if (seen.has(current.id)) return [];
    seen.add(current.id);
    path.unshift(current);
    if (current.parentId === null) return path;
    current = byId.get(current.parentId);
    if (!current) return [];
  }
  return path;
}

export function documentPathText(documents: readonly DocumentListItem[], nodeId: string): string {
  const path = documentPath(documents, nodeId);
  return path.length ? path.map(node => node.originalTitle || node.title).join(" › ") : "연결 문서를 찾을 수 없음";
}

/** Preserve actual parent links and sibling order rather than interpreting depth or title. */
export function orderedDocumentNodes(documents: readonly DocumentListItem[]): DocumentListItem[] {
  const byParent = new Map<string | null, DocumentListItem[]>();
  const ids = new Set(documents.map(node => node.id));
  for (const node of documents) {
    const parent = node.parentId && ids.has(node.parentId) ? node.parentId : null;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(node);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
  const visited = new Set<string>();
  const result: DocumentListItem[] = [];
  const visit = (node: DocumentListItem) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    result.push(node);
    for (const child of byParent.get(node.id) ?? []) visit(child);
  };
  for (const root of byParent.get(null) ?? []) visit(root);
  for (const node of documents) visit(node);
  return result;
}

export function materialNodeState(
  documents: readonly DocumentListItem[],
  item: NodeContextView,
  preferences: readonly MaterialPreferenceView[],
  nodeId: string,
): { reason: "current" | "ancestor" | "selected" | null; excluded: boolean; included: boolean } {
  const path = documentPath(documents, nodeId);
  const sourceId = item.source === "document_description" ? item.scopeId : item.id;
  const preference = preferences.find(value => value.documentNodeId === nodeId && value.source === item.source && value.sourceId === sourceId);
  const reason = !path.length ? null : item.scopeId === nodeId ? "current"
    : (item.inheritToChildren ?? true) && path.some(node => node.id === item.scopeId) ? "ancestor"
      : preference?.referenced ? "selected" : null;
  const excluded = preference?.excluded ?? false;
  return { reason, excluded, included: !!reason && (item.enabled || preference?.mode === "include") && !excluded };
}
