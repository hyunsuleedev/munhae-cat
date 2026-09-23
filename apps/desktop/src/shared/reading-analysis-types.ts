import type { AppConfig, IpcResult, ReadingAnnotationView, ReadingCitation } from "./munhae-api";

export type ReadingAnalysisRange = { from: number; to: number; quote: string };
export type ReadingAnalysisInput = {
  documentNodeId: string;
  expectedSourceVersionId: string;
  expectedTranslationVersionId: string | null;
  ranges: ReadingAnalysisRange[];
};
export type ReadingAnalysisSuggestion = ReadingAnalysisRange & {
  id: string;
  reading: string;
  readingOrder: number | null;
  /** Resolved by the app from a sense returned by this run's dictionary tool. */
  citation: ReadingCitation | null;
  /** AI interpretation, kept separate from the cited dictionary wording. */
  explanation: string;
  caution: string;
  applied: boolean;
};
export type ReadingAnalysisRun = {
  id: string;
  documentNodeId: string;
  sourceVersionId: string;
  translationVersionId: string | null;
  sourceHash: string;
  ranges: ReadingAnalysisRange[];
  agentId: AppConfig["agentId"];
  createdAt: string;
  state: "running" | "completed" | "failed" | "canceled" | "stale";
  detail: string;
  result: { summary: string; suggestions: ReadingAnalysisSuggestion[] } | null;
  error: { code: string; message: string } | null;
};
export type ApplyReadingAnalysisInput = { runId: string; suggestionId: string };
export type ReadingAnalysisApi = {
  startReadingAnalysis(input: ReadingAnalysisInput): Promise<IpcResult<ReadingAnalysisRun>>;
  getReadingAnalysis(id: string): Promise<IpcResult<ReadingAnalysisRun>>;
  latestReadingAnalysis(input: ReadingAnalysisInput): Promise<IpcResult<ReadingAnalysisRun | null>>;
  cancelReadingAnalysis(id: string): Promise<IpcResult<ReadingAnalysisRun>>;
  applyReadingAnalysis(input: ApplyReadingAnalysisInput): Promise<IpcResult<ReadingAnnotationView>>;
};
