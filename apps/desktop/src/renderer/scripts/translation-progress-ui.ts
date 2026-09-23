import type { AiRunView } from "../../shared/munhae-api";
import { t } from "./i18n";
import { createTranslationParticles } from "./translation-particles";
import "../styles/translation-progress.css";

type ProgressRun = Pick<AiRunView, "phase" | "state" | "validationState">;

export function translationProgressState(run: ProgressRun | null, starting = false, canceling = false) {
  const running = starting || run?.state === "running";
  const preparing = starting || ["queued", "starting", "preparing", "assembling", "spawning"].includes(run?.phase ?? "queued");
  const aligning = ["translation_saved", "aligning"].includes(run?.phase ?? "");
  const completed = run?.state === "completed";
  const step = completed ? 3 : preparing ? 0 : aligning ? 2 : 1;
  let title = ["번역할 자료를 모으고 있어요", "원문을 번역하고 있어요", "원문과 번역을 연결하고 있어요", "번역이 준비됐어요"][step]!;
  let description = ["원문과 참고 자료를 준비하고 있어요.", "표현에 담긴 뜻과 문맥을 함께 살피고 있어요.", "저장한 번역에 대응하는 원문을 확인하고 있어요.", "번역 결과를 확인할 수 있습니다."][step]!;
  if (completed && run?.validationState === "invalid_unapplied") {
    title = "번역을 적용하지 못했어요";
    description = "응답은 실행 기록에 보존됐지만 번역안에는 적용되지 않았습니다.";
  } else if (completed && run?.validationState === "needs_review") {
    title = "번역 결과를 검토해 주세요";
  } else if (canceling || run?.phase === "stopping") {
    title = "작업을 중지하고 있어요";
    description = "실행 중인 AI 작업을 정리하고 있습니다.";
  } else if (!starting && run?.state === "canceled") {
    title = "번역을 중지했어요";
    description = "설정으로 돌아가 다시 실행할 수 있습니다.";
  } else if (!starting && (!run || run.state === "failed")) {
    title = "번역을 완료하지 못했어요";
    description = "아래 내용을 확인한 뒤 다시 실행해 주세요.";
  }
  return { step, running, title, description, completed: completed && run?.validationState !== "invalid_unapplied" };
}

export function translationElapsed(start: string | number, end: string | number): string {
  const from = typeof start === "string" ? Date.parse(start) : start;
  const to = typeof end === "string" ? Date.parse(end) : end;
  const seconds = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.floor((to - from) / 1000)) : 0;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function translationRunLabel(run: ProgressRun | null, starting = false, canceling = false): string | null {
  const progress = translationProgressState(run, starting, canceling);
  if (!progress.running) return null;
  if (canceling || run?.phase === "stopping") return "번역 중지 중";
  if (progress.step === 0) return "번역 준비 중";
  if (progress.step === 2) return "문장 연결 중";
  return "AI 번역 중";
}

export function createTranslationProgress(dialog: HTMLDialogElement, options: {
  prefix?: string;
  label?: string;
  state?: typeof translationProgressState;
} = {}) {
  const prefix = options.prefix ?? "prep";
  const progressState = options.state ?? translationProgressState;
  const particles = createTranslationParticles(dialog.querySelector<HTMLCanvasElement>(`#${prefix}Particles`)!, dialog);
  const elapsed = dialog.querySelector<HTMLElement>(`#${prefix}Elapsed`)!;
  const steps = [...dialog.querySelectorAll<HTMLElement>(`#${prefix}RunSteps li`)];
  let run: AiRunView | null = null, starting = false, startupTime = Date.now(), terminalTime = Date.now();
  let stepSignature = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  const updateElapsed = () => {
    const text = translationElapsed(run?.startedAt ?? startupTime,
      run?.completedAt ?? (starting || run?.state === "running" ? Date.now() : terminalTime));
    if (elapsed.textContent !== text) elapsed.textContent = text;
  };
  const syncClock = () => {
    if (dialog.open && dialog.dataset.mode === "progress" && !document.hidden && (starting || run?.state === "running")) {
      if (timer === undefined) {
        updateElapsed();
        timer = setInterval(updateElapsed, 1000);
      }
    } else {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      updateElapsed();
    }
  };
  const observer = new MutationObserver(syncClock);
  observer.observe(dialog, { attributes: true, attributeFilter: ["open", "data-mode"] });
  document.addEventListener("visibilitychange", syncClock);
  return {
    update(next: AiRunView | null, nextStarting: boolean, canceling: boolean) {
      const clockChanged = run?.startedAt !== next?.startedAt || run?.completedAt !== next?.completedAt
        || run?.state !== next?.state || starting !== nextStarting;
      if (nextStarting && !starting) startupTime = Date.now();
      if (run?.state === "running" && next?.state !== "running") terminalTime = Date.now();
      run = next; starting = nextStarting;
      const progress = progressState(run, starting, canceling);
      particles.update(progress.step, progress.running);
      const signature = `${progress.step}:${progress.running}:${progress.completed}`;
      if (stepSignature !== signature) {
        stepSignature = signature;
        steps.forEach((element, index) => {
          const done = progress.completed || (progress.running && index < progress.step);
          element.classList.toggle("done", done);
          if (progress.running && index === progress.step) element.setAttribute("aria-current", "step");
          else element.removeAttribute("aria-current");
          element.querySelector(".prep-step-symbol")!.textContent = done ? "✓" : String(index + 1);
        });
        dialog.querySelector<HTMLElement>(`#${prefix}RunSteps`)!.setAttribute("aria-label", t(options.label ?? "AI 번역 진행"));
      }
      if (clockChanged) updateElapsed();
      syncClock();
    },
    dispose() {
      particles.dispose(); observer.disconnect();
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener("visibilitychange", syncClock);
    },
  };
}
