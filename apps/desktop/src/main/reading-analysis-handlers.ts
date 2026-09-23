import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import { withAccount } from "./auth";
import { AppError } from "./errors";
import { parseMessageId } from "./ipc-validate";
import { getAppConfig, requireRepo } from "./session";
import { startReadingAnalysis, getReadingAnalysis, latestReadingAnalysis, cancelReadingAnalysis, applyReadingAnalysis } from "./reading-analysis";

export const READING_ANALYSIS_CHANNELS: readonly IpcChannel[] = [
  IPC_CHANNELS.researchStartReadingAnalysis,
  IPC_CHANNELS.researchGetReadingAnalysis,
  IPC_CHANNELS.researchLatestReadingAnalysis,
  IPC_CHANNELS.researchCancelReadingAnalysis,
  IPC_CHANNELS.researchApplyReadingAnalysis,
];

/** Same authenticated boundary for Electron and the development browser. */
export async function dispatchReadingAnalysis(channel: IpcChannel, input: unknown): Promise<unknown> {
  if (!READING_ANALYSIS_CHANNELS.includes(channel)) throw new AppError("invalid_payload", "허용되지 않은 구절 분석 요청입니다.");
  const state = await withAccount(account => account.getState());
  if (state.status !== "signed_in" || !state.user) throw new AppError("auth_required", "구절 연구를 사용하려면 문해 계정에 로그인하세요.");
  const repo = requireRepo();
  switch (channel) {
    case IPC_CHANNELS.researchStartReadingAnalysis: return startReadingAnalysis(repo, getAppConfig(), input);
    case IPC_CHANNELS.researchGetReadingAnalysis: return getReadingAnalysis(repo, parseMessageId(input));
    case IPC_CHANNELS.researchLatestReadingAnalysis: return latestReadingAnalysis(repo, input);
    case IPC_CHANNELS.researchCancelReadingAnalysis: return cancelReadingAnalysis(repo, parseMessageId(input));
    case IPC_CHANNELS.researchApplyReadingAnalysis: return applyReadingAnalysis(repo, input);
  }
}
