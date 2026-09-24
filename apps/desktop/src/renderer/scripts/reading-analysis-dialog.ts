import type { AgentProbe, AiRunView, AppConfig, MunhaeApi } from "../../shared/munhae-api";
import type { ReadingAnalysisState } from "./reading-analysis-session";
import { prepModelMarkup, changePrepModelSetting } from "./translation-setup-ui";
import { createTranslationProgress } from "./translation-progress-ui";
import { uiText, t } from "./i18n";

type Deps = {
  api: MunhaeApi;
  trigger: HTMLButtonElement;
  start(): Promise<boolean>;
  cancel(): Promise<void>;
  review(): void;
};
export function readingProgressState(run: Pick<AiRunView, "phase" | "state" | "validationState"> | null, starting = false, canceling = false) {
  const running = starting || run?.state === "running", completed = run?.state === "completed";
  const step = completed ? 2 : starting ? 0 : 1;
  const title = canceling ? "분석을 취소하고 있어요" : starting ? "구절 분석을 준비하고 있어요" : running ? "독음과 뜻풀이를 살피고 있어요" : completed ? "구절 분석이 준비됐어요" : run?.state === "canceled" ? "분석을 취소했어요" : "분석을 완료하지 못했어요";
  return { running, completed, step, title, description: completed ? "제안을 검토한 뒤 필요한 풀이만 채택하세요." : running ? "현재 구절의 문맥과 사전 근거를 확인합니다." : "설정으로 돌아가 다시 실행할 수 있습니다." };
}

export function createReadingAnalysisDialog(deps: Deps) {
  const dialog = deps.trigger.ownerDocument.createElement("dialog");
  dialog.id = "dlgReadingAnalysis"; dialog.className = "ai-run-dialog"; dialog.dataset.mode = "setup";
  dialog.setAttribute("aria-labelledby", "readingPrepHeading");
  dialog.innerHTML = uiText(`<div class="ai-run-head"><div class="prep-heading-copy"><h2 id="readingPrepHeading">구절 AI 분석</h2><p id="readingPrepTitle"></p></div><button class="ai-run-close" id="readingCloseTop" type="button" aria-label="닫기">×</button></div>
    <div class="ai-run-body"><div class="ai-run-main">
      <section class="prep-ai-settings"><div class="prep-ai-fields"><div class="field"><label for="readingAgent">AI</label><select class="select" id="readingAgent"><option value="claude">Claude</option><option value="codex">Codex</option><option value="antigravity">Antigravity</option></select></div><div id="readingModels"></div></div><p class="prep-model-hint">선택한 AI와 모델은 AI 설정에도 반영됩니다.</p><p id="readingConnection" role="status"></p></section>
      <section class="prep-materials"><div class="prep-section-heading"><h3>분석할 구절</h3><span id="readingSourceInfo"></span></div><pre class="hanmun" id="readingSource"></pre><p class="prep-readable-note">독음·어휘 묶음·사전 근거를 제안합니다. 검토한 풀이만 직접 채택하세요.</p></section>
    </div><aside class="ai-run-aside" id="readingProgress" hidden aria-label="구절 AI 분석 진행"><section class="prep-run-progress"><div class="prep-particle-stage" id="readingRunMeter" role="progressbar" aria-label="구절 AI 분석 진행"><canvas id="readingParticles" aria-hidden="true"></canvas><div class="prep-stage-status"><span class="tag tag-line" id="readingRunState"></span><h3 class="prep-run-phase" id="readingRunPhase" aria-live="polite"></h3><p class="prep-run-detail" id="readingRunDetail"></p><div class="prep-elapsed"><span id="readingElapsed">00:00</span><span>경과</span></div></div></div><ol class="prep-run-steps" id="readingRunSteps"><li><span class="prep-step-symbol">1</span><span>자료 준비</span></li><li><span class="prep-step-symbol">2</span><span>구절 분석</span></li><li><span class="prep-step-symbol">3</span><span>완료</span></li></ol></section></aside></div>
    <p class="prep-run-error" id="readingError" role="alert" hidden></p><div class="ai-run-foot"><span class="prep-background-note" id="readingFootnote"></span><span class="sp"></span><button class="btn btn-ghost" id="readingClose" type="button">닫기</button><button class="btn" id="readingBack" type="button" hidden>설정으로 돌아가기</button><button class="btn" id="readingCancel" type="button" hidden>취소</button><button class="btn btn-primary" id="readingReview" type="button" hidden>제안 검토</button><button class="btn btn-primary" id="readingStart" type="button">분석 시작</button></div>`);
  deps.trigger.ownerDocument.body.append(dialog);
  deps.trigger.setAttribute("aria-haspopup", "dialog"); deps.trigger.setAttribute("aria-controls", dialog.id);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const motion = createTranslationProgress(dialog, { prefix: "reading", label: "구절 AI 분석 진행", state: readingProgressState });
  let state: ReadingAnalysisState | null = null, config: AppConfig | null = null, probes: AgentProbe[] = [];
  let loading = false, launching = false, error = "", generation = 0;
  const agent = () => el<HTMLSelectElement>("readingAgent").value as AppConfig["agentId"];
  const probe = () => probes.find(item => item.agentId === agent());
  const ready = () => !!probe()?.installed && (probe()?.loggedIn === true || (agent() === "antigravity" && probe()?.loggedIn === null));
  const active = () => launching || !!state?.starting || !!state?.canceling || state?.run?.state === "running";
  function models() {
    el("readingModels").innerHTML = config ? prepModelMarkup(config, probe(), agent()).replaceAll("prep-model-", "reading-model-") : "";
    render();
  }
  function render() {
    const progressMode = dialog.dataset.mode === "progress", running = active(), completed = state?.run?.state === "completed";
    el("readingProgress").hidden = !progressMode;
    el("readingConnection").textContent = loading ? t("연결 확인 중…") : ready() ? t("연결됨") : t("AI 설치와 로그인 상태를 확인하세요.");
    el<HTMLSelectElement>("readingAgent").disabled = loading || running;
    for (const field of dialog.querySelectorAll<HTMLSelectElement>("#readingModels select")) field.disabled = loading || running || field.dataset.capabilityDisabled === "true";
    el<HTMLButtonElement>("readingStart").disabled = loading || running || !config || !ready();
    el("readingStart").hidden = progressMode;
    el("readingBack").hidden = !progressMode || running;
    el("readingCancel").hidden = !progressMode || !running;
    el<HTMLButtonElement>("readingCancel").disabled = launching || !!state?.canceling;
    el("readingReview").hidden = !progressMode || !completed || running;
    el("readingFootnote").textContent = running ? t("닫아도 분석은 계속됩니다.") : t("제안은 검토 후 직접 채택합니다.");
    const run = state?.run;
    const adapted = run ? { state: run.state === "stale" ? "failed" : run.state, phase: "running", validationState: run.state === "completed" ? "valid" : null, startedAt: run.createdAt } as AiRunView : null;
    const progress = readingProgressState(adapted, launching || !!state?.starting, !!state?.canceling);
    motion.update(adapted, launching || !!state?.starting, !!state?.canceling);
    el("readingRunPhase").textContent = t(progress.title);
    el("readingRunDetail").textContent = run?.detail || t(progress.description);
    el("readingRunState").textContent = t(running ? "실행 중" : completed ? "완료" : run?.state === "canceled" ? "취소됨" : "확인 필요");
    el("readingRunMeter").setAttribute("aria-busy", String(running));
    el("readingRunMeter").setAttribute("aria-valuetext", t(progress.title));
    el("readingRunMeter").dataset.state = adapted?.state ?? "running";
    el("readingError").textContent = error || (progressMode ? state?.error || (run?.state === "canceled" ? "" : run?.error?.message) || "" : "");
    el("readingError").hidden = !el("readingError").textContent;
  }
  async function loadSettings() {
    const ticket = ++generation; loading = true; error = ""; render();
    try {
      const [settings, agents] = await Promise.all([deps.api.app.getConfig(), deps.api.app.probeAgents()]);
      if (ticket !== generation) return;
      config = settings; probes = agents; el<HTMLSelectElement>("readingAgent").value = config.agentId; models();
    } catch (cause) { if (ticket === generation) error = cause instanceof Error ? cause.message : t("AI 설정을 불러오지 못했습니다. 다시 열어 주세요."); }
    finally { if (ticket === generation) { loading = false; render(); } }
  }
  async function start() {
    if (active() || loading || !config || !ready()) return;
    const ticket = generation, selected = agent(), preferences = structuredClone(config.agentModels[selected]);
    launching = true; error = ""; dialog.dataset.mode = "progress"; render();
    try {
      const latest = await deps.api.app.getConfig();
      if (ticket !== generation) return;
      await deps.api.app.setConfig({ agentId: selected, agentModels: { ...latest.agentModels, [selected]: preferences } });
      if (ticket !== generation) return;
      if (!await deps.start()) error = state?.error || t("분석을 시작하지 못했습니다. 편집 중인 풀이와 AI 상태를 확인하세요.");
    } catch (cause) { if (ticket === generation) error = cause instanceof Error ? cause.message : t("AI 설정을 저장하지 못했습니다."); }
    finally { if (ticket === generation) { launching = false; render(); } }
  }
  el("readingAgent").addEventListener("change", models);
  el("readingModels").addEventListener("change", event => {
    const field = event.target as HTMLSelectElement;
    if (!config || active() || loading || !field.dataset.prepModelSetting) return;
    if (changePrepModelSetting(config, probe(), agent(), field.dataset.prepModelSetting, field.value)) models();
  });
  el("readingStart").addEventListener("click", () => void start());
  el("readingCancel").addEventListener("click", () => void deps.cancel());
  el("readingBack").addEventListener("click", () => { dialog.dataset.mode = "setup"; error = ""; void loadSettings(); });
  el("readingReview").addEventListener("click", () => { dialog.close(); deps.review(); });
  for (const id of ["readingClose", "readingCloseTop"]) el(id).addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => deps.trigger.focus({ preventScroll: true }));
  return {
    open(title: string, quote: string) {
      el("readingPrepTitle").textContent = title; el("readingSource").textContent = quote;
      el("readingSourceInfo").textContent = `${Array.from(quote).length}자`;
      dialog.dataset.mode = active() ? "progress" : "setup";
      if (!dialog.open) dialog.showModal();
      if (!active()) void loadSettings(); else render();
    },
    update(next: ReadingAnalysisState) { state = next; render(); },
    reset() { ++generation; launching = false; loading = false; error = ""; if (dialog.open) dialog.close(); },
    dispose() { ++generation; motion.dispose(); dialog.remove(); },
  };
}
