import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import { ONLINE_PROJECTS_ENABLED } from "../shared/online-projects";
import { withAuthenticatedClient } from "./auth";
import { AppError } from "./errors";
import { OnlineProjectsService } from "./online-projects";
import { openOnlineProject, getOnlineWorkspaceStatus, syncOnlineWorkspace, exportOnlineRecovery } from "./session";

export const ONLINE_PROJECT_CHANNELS: IpcChannel[] = [
  IPC_CHANNELS.onlineProjectsCreate, IPC_CHANNELS.onlineProjectsList, IPC_CHANNELS.onlineProjectsGet,
  IPC_CHANNELS.onlineProjectsOpen, IPC_CHANNELS.onlineProjectsStatus, IPC_CHANNELS.onlineProjectsSync,
  IPC_CHANNELS.onlineProjectsExportRecovery,
  IPC_CHANNELS.onlineProjectsSharing, IPC_CHANNELS.onlineProjectsInvitations, IPC_CHANNELS.onlineProjectsInvite, IPC_CHANNELS.onlineProjectsRespond, IPC_CHANNELS.onlineProjectsCancelInvitation, IPC_CHANNELS.onlineProjectsUpdateMember,
];
const service = new OnlineProjectsService(withAuthenticatedClient);

export function dispatchOnlineProject(channel: IpcChannel, input?: unknown): Promise<unknown> {
  if (!ONLINE_PROJECTS_ENABLED && (channel === IPC_CHANNELS.onlineProjectsCreate || channel === IPC_CHANNELS.onlineProjectsInvite)) {
    throw new AppError("online_projects_paused", "온라인 프로젝트는 준비 중입니다.");
  }
  switch (channel) {
    case IPC_CHANNELS.onlineProjectsOpen: return openOnlineProject(input);
    case IPC_CHANNELS.onlineProjectsStatus: return Promise.resolve(getOnlineWorkspaceStatus());
    case IPC_CHANNELS.onlineProjectsSync: return syncOnlineWorkspace();
    case IPC_CHANNELS.onlineProjectsExportRecovery: return exportOnlineRecovery(input);
    case IPC_CHANNELS.onlineProjectsCreate: return service.create(input);
    case IPC_CHANNELS.onlineProjectsList: return service.list();
    case IPC_CHANNELS.onlineProjectsGet: return service.get(input);
    case IPC_CHANNELS.onlineProjectsSharing: return service.sharing(input);
    case IPC_CHANNELS.onlineProjectsInvitations: return service.invitations();
    case IPC_CHANNELS.onlineProjectsInvite: return service.invite(input);
    case IPC_CHANNELS.onlineProjectsRespond: return service.respond(input);
    case IPC_CHANNELS.onlineProjectsCancelInvitation: return service.cancelInvitation(input);
    case IPC_CHANNELS.onlineProjectsUpdateMember: return service.updateMember(input);
    default: throw new AppError("invalid_channel", "허용되지 않은 온라인 프로젝트 요청입니다.");
  }
}
