import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import { withAccount } from "./auth";
import { AppError } from "./errors";
import { parseArchiveReadingAnnotationInput, parseDocumentNodeId, parseSaveReadingAnnotationInput } from "./ipc-validate";
import { requireRepo } from "./session";

export const READING_ANNOTATION_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.editorListReadingAnnotations,
  IPC_CHANNELS.editorSaveReadingAnnotation,
  IPC_CHANNELS.editorArchiveReadingAnnotation,
];

/** Native IPC and the development browser share authentication and payload validation. */
export async function dispatchReadingAnnotation(channel: IpcChannel, input: unknown): Promise<unknown> {
  if (!READING_ANNOTATION_CHANNELS.includes(channel)) {
    throw new AppError("invalid_payload", "허용되지 않은 구절 연구 요청입니다.");
  }
  const state = await withAccount((account) => account.getState());
  if (state.status !== "signed_in" || !state.user) {
    throw new AppError("auth_required", "구절 연구를 사용하려면 문해 계정에 로그인하세요.");
  }
  // Keep database failures outside withAccount, which translates authentication errors.
  switch (channel) {
    case IPC_CHANNELS.editorListReadingAnnotations:
      return requireRepo().listReadingAnnotations(parseDocumentNodeId(input));
    case IPC_CHANNELS.editorSaveReadingAnnotation:
      return requireRepo().saveReadingAnnotation(parseSaveReadingAnnotationInput(input));
    case IPC_CHANNELS.editorArchiveReadingAnnotation:
      return requireRepo().archiveReadingAnnotation(parseArchiveReadingAnnotationInput(input));
  }
}
