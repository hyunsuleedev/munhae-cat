import type { DocumentListItem } from "../../shared/munhae-api";
import { documentPath } from "./knowledge-model";
export { documentPath as materialNodePath, documentPathText as materialPathLabel } from "./knowledge-model";

export function materialScopeNodes(documents: DocumentListItem[], scopeId: string, inheritToChildren: boolean): DocumentListItem[] {
  return documents.filter(node => node.id === scopeId || inheritToChildren
    && documentPath(documents, node.id).some(parent => parent.id === scopeId));
}
