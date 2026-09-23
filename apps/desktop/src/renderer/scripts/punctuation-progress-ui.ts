import type { AiRunView } from "../../shared/munhae-api";
import { t } from "./i18n";
import { createTranslationProgress } from "./translation-progress-ui";

type ProgressRun = Pick<AiRunView, "phase" | "state" | "validationState">;
export function punctuationProgressState(run: ProgressRun | null, starting = false, canceling = false) {
  const running = starting || run?.state === "running";
  const completed = run?.state === "completed" && run.validationState === "valid";
  const preparing = starting || ["queued", "starting", "preparing", "assembling", "spawning"].includes(run?.phase ?? "queued");
  const step = completed ? 3 : preparing ? 0 : ["validating", "validation_failed"].includes(run?.phase ?? "") || run?.state === "completed" ? 2 : 1;
  let title = ["표점할 자료를 준비하고 있어요", "원문에 표점을 더하고 있어요", "원문 문자를 확인하고 있어요", "표점 제안이 준비됐어요"][step]!;
  let description = ["확정 원문과 표점 지침을 준비합니다.", "문맥에 맞는 표점과 논리 구조를 살피고 있어요.", "생성된 제안이 원문 문자를 보존했는지 확인합니다.", "원문과 대조한 뒤 적용하고 직접 확정하세요."][step]!;
  if (canceling || run?.phase === "stopping") {
    title = "작업을 중지하고 있어요"; description = "실행 중인 AI 작업을 정리하고 있습니다.";
  } else if (!starting && run?.state === "canceled") {
    title = "표점 생성을 중지했어요"; description = "설정으로 돌아가 다시 실행할 수 있습니다.";
  } else if (!starting && (!run || run.state === "failed")) {
    title = "표점 생성을 완료하지 못했어요"; description = "아래 내용을 확인한 뒤 다시 실행해 주세요.";
  } else if (run?.state === "completed" && !completed) {
    title = "표점 제안을 확인해 주세요"; description = "원문 검증을 통과하지 못해 적용할 수 없습니다.";
  }
  return { step, running, completed, title, description };
}

export function createPunctuationProgress(dialog: HTMLDialogElement) {
  const motion = createTranslationProgress(dialog, { prefix: "punctuation", label: "AI 표점 진행", state: punctuationProgressState });
  const element = (suffix: string) => dialog.querySelector<HTMLElement>(`#punctuation${suffix}`)!;
  return {
    dispose: motion.dispose,
    update(run: AiRunView | null, starting: boolean, canceling: boolean, errorText: string) {
      const progress = punctuationProgressState(run, starting, canceling);
      motion.update(run, starting, canceling);
      const state = starting ? "running" : run?.state ?? "failed";
      const label = progress.running ? t(canceling || run?.phase === "stopping" ? "취소 요청 중" : "실행 중") : t(progress.completed ? "완료" : state === "canceled" ? "취소됨" : "확인 필요");
      const meter = element("RunMeter");
      meter.dataset.state = state;
      meter.dataset.validation = run?.validationState ?? "";
      meter.setAttribute("aria-valuetext", label);
      meter.setAttribute("aria-busy", String(progress.running));
      element("RunState").textContent = label;
      element("RunPhase").textContent = t(progress.title);
      element("RunDetail").textContent = t(progress.description);
      element("LatestActivity").textContent = t(["자료 준비", "표점 생성", "원문 검증", "완료"][progress.step]!);
      element("ActivityDetail").textContent = run?.detail ? t(run.detail) : t(progress.description);
      element("RunError").textContent = errorText;
      element("RunError").hidden = !errorText;
    },
  };
}
