import { t } from "./i18n";
import type { DocumentListItem, GlossaryEntryView, MaterialPreferenceView, NodeContextView } from "../../shared/munhae-api";

export const KNOWLEDGE_PAGES = ["context", "glossary", "comments", "uncertainty"] as const;
export type KnowledgePage = typeof KNOWLEDGE_PAGES[number];

/** Each translation-material page names itself on `<body data-knowledge-page>`. */
export function knowledgePage(value: string | undefined): KnowledgePage {
  return KNOWLEDGE_PAGES.find(page => page === value) ?? "context";
}

export const USAGE_LABELS: Record<GlossaryEntryView["usageStatus"], string> = {
  preferred: t("기본"),
  allowed: t("허용"),
  forbidden: t("지양"),
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
  return path.length ? path.map(node => node.originalTitle || node.title).join(" › ") : t("연결 문서를 찾을 수 없음");
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
  return { reason, excluded, included: !(item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable) && !!reason && (item.enabled || preference?.mode === "include") && !excluded };
}
