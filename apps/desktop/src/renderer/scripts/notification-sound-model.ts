import type { AiRunView } from "../../shared/munhae-api";

export function completionCue(run: AiRunView): { id: string; kind: "chat" | "stage" } | null {
  const stage = run.completionStage;
  if (!stage || run.error || run.state === "failed" || run.state === "canceled" || run.validationState === "invalid_unapplied") return null;
  if (stage === "chat" && run.taskKind === "chat" && run.state === "completed") return { id: `${run.messageId}:${stage}`, kind: "chat" };
  if (stage === "punctuation" && run.taskKind === "punctuation_suggest" && run.state === "completed") return { id: `${run.messageId}:${stage}`, kind: "stage" };
  if (run.taskKind === "translation" && (stage === "translation" || stage === "alignment") && (run.state === "completed" || run.phase === "translation_saved")) return { id: `${run.messageId}:${stage}`, kind: "stage" };
  return null;
}
