import { randomUUID } from "node:crypto";
import { webContents } from "electron";
import { IPC_CHANNELS, type McpChangeEvent, type McpChangeView } from "../shared/munhae-api";
import { AppError } from "./errors";
import { isAllowedNavigation } from "./security";
import { getCurrentSummary, withOnlineProjectSave } from "./session";

type Change = McpChangeView & { sessionId: string; scopes: string[]; undo(): void };

// Kept in memory only and dropped when the app quits (decided 2026-09-29).
const changes: Change[] = [];
const MAX_CHANGES = 200;
let editingDocumentId: string | null = null;

const view = ({ sessionId: _s, scopes: _c, undo: _u, ...change }: Change): McpChangeView => ({ ...change });

function broadcast(change: Change): void {
  const event: McpChangeEvent = { change: view(change), documentIds: [change.documentId], scopes: change.scopes };
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && isAllowedNavigation(contents.getURL())) contents.send(IPC_CHANNELS.mcpChanged, event);
  }
}

export function recordMcpChange(input: {
  projectId: string;
  documentId: string;
  sessionId: string;
  label: string;
  summary: string;
  scopes: string[];
  undo(): void;
}): McpChangeView {
  const change: Change = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), undoneAt: null };
  changes.push(change);
  if (changes.length > MAX_CHANGES) changes.splice(0, changes.length - MAX_CHANGES);
  broadcast(change);
  return view(change);
}

/** Undo from the app (any change) or from the AI tool that made it (`sessionId`). */
export async function undoMcpChange(changeId: string, sessionId?: string): Promise<McpChangeView> {
  const change = changes.find(item => item.id === changeId);
  if (!change || (sessionId !== undefined && change.sessionId !== sessionId)) {
    throw new AppError("not_found", "되돌릴 변경을 찾을 수 없습니다. 이 대화에서 이번 앱 실행 중에 만든 변경만 되돌릴 수 있습니다.");
  }
  if (change.undoneAt) throw new AppError("already_undone", "이미 되돌린 변경입니다.");
  if (getCurrentSummary()?.projectId !== change.projectId) throw new AppError("project_changed", "문해에서 열린 프로젝트가 바뀌어 되돌릴 수 없습니다.");
  await withOnlineProjectSave(() => change.undo());
  change.undoneAt = new Date().toISOString();
  broadcast(change);
  return view(change);
}

export function listMcpChanges(projectId: string): McpChangeView[] {
  return changes.filter(change => change.projectId === projectId).map(view).reverse();
}

export function setEditingDocument(documentId: unknown): void {
  if (documentId !== null && (typeof documentId !== "string" || !documentId || documentId.length > 128)) {
    throw new AppError("invalid_input", "편집 중인 문서를 확인하세요.");
  }
  editingDocumentId = documentId;
}

export function editingDocument(): string | null {
  return editingDocumentId;
}
