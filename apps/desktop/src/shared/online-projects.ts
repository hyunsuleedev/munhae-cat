/** Paused until local-first work settles (docs/online-projects.md). Hides creation and
 * invitations; existing online code stays in place and does not follow new local schema. */
export const ONLINE_PROJECTS_ENABLED = false;

/** PostgreSQL-backed projects; local paths are disposable editor caches. */
export type OnlineProject = {
  id: string;
  ownerId: string;
  title: string;
  description: string;
  storageMode: "online";
  role: OnlineProjectRole;
  /** Authenticated viewer; distinct from the project owner for shared projects. */
  accountId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateOnlineProjectInput = {
  title: string;
  description?: string;
  /** Keep this ID when retrying an uncertain network result. */
  requestId: string;
};

export type OnlineWorkspaceStatus = {
  projectId: string;
  sessionId: string;
  state: "synced" | "pending" | "syncing" | "error" | "conflict" | "locked";
  revision: number;
  realtimeConnected?: boolean;
  dirty: boolean;
  writable: boolean;
  role?: OnlineProjectRole;
  message: string | null;
  updatedAt: string | null;
};
export type OpenOnlineProjectInput = { id: string; discardLocal?: boolean };

export type ProjectChangeEvent = {
  projectId: string;
  accountId: string;
  sessionId: string;
  revision: number;
  reason: "commit" | "resync";
  documentIds: string[];
  scopes: string[];
};
export function projectChangePayload(value: unknown): ProjectChangeEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (![row.projectId, row.accountId, row.sessionId].every(id => typeof id === "string" && id.length > 0 && id.length < 128)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0
    || !["commit", "resync"].includes(String(row.reason))
    || ![row.documentIds, row.scopes].every(ids => Array.isArray(ids) && ids.length <= 10000 && ids.every(id => typeof id === "string" && id.length < 128))) return null;
  return value as ProjectChangeEvent;
}

export type OnlineProjectRole = "owner" | "editor" | "viewer";
export type ProjectMemberRole = "editor" | "viewer";
export const onlineProjectAccount = (project: OnlineProject): string => project.accountId ?? project.ownerId;
export type ProjectSharing = {
  projectId: string; role: OnlineProjectRole; memberLimit: number; usedSeats: number; canInvite: boolean; initialized: boolean;
  members: { userId: string; email: string | null; displayName: string; role: OnlineProjectRole }[];
  invitations: { id: string; email: string; role: ProjectMemberRole; expiresAt: string }[];
};
export type ProjectInvitation = { id: string; projectId: string; projectTitle: string; role: ProjectMemberRole; expiresAt: string };
export type InviteProjectMemberInput = { projectId: string; email: string; role: ProjectMemberRole };
export type UpdateProjectMemberInput = { projectId: string; userId: string; role: ProjectMemberRole | null };
