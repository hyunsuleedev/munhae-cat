import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import { withAccount } from "./auth";
import { AppError } from "./errors";
import { parseDocumentNodeId, parseReuseCommentAsMaterialInput, parseSetMaterialPreferenceInput } from "./ipc-validate";
import { requireRepo } from "./session";

export const MATERIAL_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.knowledgeGetMaterials,
  IPC_CHANNELS.knowledgeSetMaterialPreference,
  IPC_CHANNELS.knowledgeReuseCommentAsMaterial,
];

/** The Electron and browser surfaces use the same account and input checks. */
export async function dispatchMaterial(channel: IpcChannel, input: unknown): Promise<unknown> {
  if (!MATERIAL_CHANNELS.includes(channel)) throw new AppError("invalid_payload", "허용되지 않은 번역 자료 요청입니다.");
  const state = await withAccount(account => account.getState());
  if (state.status !== "signed_in" || !state.user) throw new AppError("auth_required", "번역 자료를 사용하려면 문해 계정에 로그인하세요.");
  switch (channel) {
    case IPC_CHANNELS.knowledgeGetMaterials:
      return requireRepo().getMaterials(input == null ? undefined : parseDocumentNodeId(input));
    case IPC_CHANNELS.knowledgeSetMaterialPreference:
      return requireRepo().setMaterialPreference(parseSetMaterialPreferenceInput(input));
    case IPC_CHANNELS.knowledgeReuseCommentAsMaterial:
      return requireRepo().reuseCommentAsMaterial(parseReuseCommentAsMaterialInput(input));
  }
}
