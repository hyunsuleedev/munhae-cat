import type { DocumentListItem } from "../../shared/munhae-api";

export function resolveContextNode(
  documents: DocumentListItem[],
  requestedId: string | null,
  currentId: string | null,
): DocumentListItem | undefined {
  // An explicit link must never silently open a different document.
  if (requestedId !== null) return documents.find((document) => document.id === requestedId);
  return documents.find((document) => document.id === currentId)
    ?? documents.find((document) => document.isMaster);
}
