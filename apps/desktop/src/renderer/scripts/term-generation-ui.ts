import { relatedTermGlossary, type TermGlossarySelection } from "../../shared/term-glossary";
import { termSource } from "@munhae/domain/term-source";
import type { AppConfig, AgentProbe, EditorView, MunhaeApi, TermExtractionRun } from "../../shared/munhae-api";
import { esc } from "./shared";
import { prepModelMarkup, changePrepModelSetting } from "./translation-setup-ui";
import { chatActivityMarkup } from "./thinking-ui";
import { createTranslationParticles } from "./translation-particles";
import { translationElapsed } from "./translation-progress-ui";
import "../styles/term-generation.css";

export function configureTermGeneration(options: {
  api: MunhaeApi; view(): EditorView | null; start(excludedMaterialIds: string[], glossarySelection: TermGlossarySelection): Promise<void>; cancel(): Promise<void>;
}) {
  const dialog = document.createElement("dialog");
  dialog.className = "ai-run-dialog term-generation-dialog";
  dialog.dataset.mode = "setup";
  dialog.setAttribute("aria-labelledby", "termGenerationHeading");
  dialog.innerHTML = `<div class="ai-run-head"><div class="prep-heading-copy"><span class="ai-run-eyebrow">현재 문서에서 실행</span><h2 id="termGenerationHeading">AI 용어 생성</h2><p data-title></p></div><button class="ai-run-close" data-close aria-label="닫기" type="button">×</button></div>
    <div class="ai-run-body"><section data-setup><details class="prep-disclosure term-model-settings"><summary><span class="prep-disclosure-chevron">›</span>모델 설정 <span class="prep-disclosure-summary" data-model-summary></span></summary><div class="prep-ai-settings-body"><div class="prep-ai-fields"><div class="field"><label for="term-generation-agent">AI</label><select id="term-generation-agent" class="select" data-agent><option value="claude">Claude</option><option value="codex">Codex</option><option value="antigravity">Gemini · Antigravity</option></select></div><div data-model-fields></div></div><p class="prep-model-hint">실행하면 선택한 모델과 응답 설정을 AI 설정에도 반영합니다.</p><p class="prep-model-hint" data-connection role="status"></p></div></details>
    <div class="term-generation-materials"><div class="term-materials-heading"><h3>참고 자료</h3><span>현재 문서 기준</span></div><p data-materials></p><div class="term-materials-stack"><details class="prep-disclosure term-source-disclosure"><summary><span class="prep-disclosure-chevron" aria-hidden="true">›</span><span data-source-label>원문 확인</span><span class="prep-disclosure-summary" data-source-count></span></summary><pre data-source></pre></details><details class="prep-disclosure term-context-disclosure" data-context-disclosure open hidden><summary><span class="prep-disclosure-chevron" aria-hidden="true">›</span>적용 문맥 <span class="term-count" data-context-count></span></summary><div data-context-list></div></details></div><details class="prep-disclosure term-context-disclosure" data-reference-disclosure hidden><summary><span class="prep-disclosure-chevron" aria-hidden="true">›</span>참고 코멘트 <span class="term-count" data-reference-count></span></summary><div data-reference-list></div></details><details class="prep-disclosure term-context-disclosure" data-glossary-disclosure><summary><input type="checkbox" data-glossary-enabled checked aria-label="공통 용어집 참고"><span class="prep-disclosure-chevron" aria-hidden="true">›</span>공통 용어집 참고 <span class="term-count" data-glossary-count></span></summary><p class="prep-model-hint term-glossary-hint">본문에 표기가 등장하는 항목입니다. 기존 풀이가 이번 문맥에도 맞는지 AI가 검토합니다.</p><div data-glossary-list></div></details><p class="term-generation-hint">인물·지명·전고와 문맥에 따른 뜻풀이를 후보로 정리합니다.</p></div></section>
    <section data-progress hidden><div class="prep-particle-stage" role="progressbar" aria-label="용어 생성 진행"><canvas data-particles aria-hidden="true"></canvas><div class="prep-stage-status"><span class="tag tag-line term-generation-state" data-state></span><h3 class="prep-run-phase" data-phase aria-live="polite"></h3><p class="prep-run-detail" data-detail></p><div class="prep-elapsed"><span data-elapsed>00:00</span> 경과</div></div></div><ol class="prep-run-steps"><li><span class="prep-step-symbol">1</span>자료 준비</li><li><span class="prep-step-symbol">2</span>용어 추출</li><li><span class="prep-step-symbol">3</span>완료</li></ol><details class="prep-activity-disclosure"><summary><span>AI 작업 내역</span><span data-latest></span></summary><div data-activity></div><p class="prep-activity-detail" data-no-activity>AI가 전달하는 생각 과정과 도구 사용 내역이 여기에 표시됩니다.</p></details></section><p class="prep-run-error" data-error role="alert" hidden></p></div>
    <div class="ai-run-foot"><span class="prep-background-note" data-foot-note>용어 생성은 선택 사항입니다.</span><span class="sp"></span><button class="btn" data-back hidden>설정으로</button><button class="btn btn-ghost" data-cancel hidden>중지</button><button class="btn" data-close data-bottom-close>닫기</button><button class="btn btn-primary" data-start disabled>용어 생성</button></div>`;
  document.body.append(dialog);
  const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!;
  const particles = createTranslationParticles(get<HTMLCanvasElement>("[data-particles]"), dialog);
  let config: AppConfig | null = null;
  let probes: AgentProbe[] = [];
  let run: TermExtractionRun | null = null;
  let starting = false, submitting = false, canceling = false, loading = false;
  let startedAt = Date.now(), endedAt = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  let opener: HTMLElement | null = null;
  let openSerial = 0;
  let materialsReady = false;
  const excludedMaterialIds = new Set<string>();
  const excludedGlossaryIds = new Set<string>();
  function glossaryCounts() {
    const enabled = get<HTMLInputElement>("[data-glossary-enabled]").checked;
    const inputs = [...dialog.querySelectorAll<HTMLInputElement>("[data-glossary-id]")];
    inputs.forEach(input => { input.disabled = !enabled; });
    get("[data-glossary-count]").textContent = enabled ? `${inputs.filter(input => input.checked).length} / ${inputs.length}개 참고` : "참고 안 함";
  }

  function materialCounts() {
    for (const kind of ["context", "reference"]) {
      const inputs = [...dialog.querySelectorAll<HTMLInputElement>(`[data-${kind}-list] [data-material-id]`)];
      get(`[data-${kind}-count]`).textContent = `${inputs.filter(input => input.checked).length} / ${inputs.length}개 참고`;
    }
  }
  const probe = () => probes.find(p => p.agentId === config?.agentId);
  const running = () => starting || submitting || run?.state === "running";
  function settings() {
    if (!config) return;
    get<HTMLSelectElement>("[data-agent]").value = config.agentId;
    // Separate IDs preserve label associations when the translation dialog is also mounted.
    get("[data-model-fields]").innerHTML = prepModelMarkup(config, probe(), config.agentId).replaceAll("prep-model-", "term-generation-model-");
    const prefs = config.agentModels[config.agentId];
    get("[data-model-summary]").textContent = [prefs.model, prefs.reasoning].filter(Boolean).join(" · ");
    const p = probe();
    get("[data-connection]").textContent = !p?.installed ? "CLI 설치를 확인하세요." : p.loggedIn === false ? "CLI 로그인이 필요합니다." : p.loggedIn === null && config.agentId !== "antigravity" ? "CLI 로그인 상태를 확인하지 못했습니다." : "연결됨";
    get<HTMLButtonElement>("[data-start]").disabled = !materialsReady || loading || running() || !p?.installed || p.loggedIn === false || p.loggedIn === null && config.agentId !== "antigravity";
  }
  function clock() { get("[data-elapsed]").textContent = translationElapsed(startedAt, running() ? Date.now() : endedAt); }
  function render() {
    const progress = dialog.dataset.mode === "progress";
    get("[data-setup]").hidden = progress;
    get("[data-progress]").hidden = !progress;
    get("[data-start]").hidden = progress;
    get("[data-cancel]").hidden = !progress || !running();
    get<HTMLButtonElement>("[data-cancel]").disabled = canceling || starting || submitting;
    get("[data-back]").hidden = !progress || running();
    get("[data-bottom-close]").textContent = progress ? running() ? "백그라운드로" : run?.state === "completed" ? "용어 확인" : "닫기" : "닫기";
    get("[data-foot-note]").textContent = progress && running() ? "창을 닫아도 용어 생성은 계속됩니다." : "생성된 후보는 검토 후 번역에 반영합니다.";
    if (progress) {
      const complete = run?.state === "completed";
      get("[data-state]").textContent = canceling ? "중지 중" : starting || submitting ? "준비 중" : run?.state === "running" ? "생성 중" : complete ? "완료" : run?.state === "canceled" ? "중지됨" : "실패";
      get("[data-phase]").textContent = canceling ? "용어 생성을 중지하고 있어요" : starting || submitting ? "용어를 찾을 자료를 준비해요" : run?.state === "running" ? "원문에서 주요 용어를 찾고 있어요" : complete ? "용어 후보가 준비됐어요" : run?.state === "canceled" ? "용어 생성을 중지했어요" : "용어를 생성하지 못했어요";
      get("[data-detail]").textContent = complete ? `${run!.count}개 후보를 저장했습니다. 뜻풀이와 확인할 점을 살펴보세요.` : "인물·전고·문맥상 의미를 살펴봅니다.";
      const step = starting || submitting ? 0 : complete ? 2 : 1;
      dialog.querySelectorAll<HTMLElement>(".prep-run-steps li").forEach((el, i) => { el.classList.toggle("done", complete || i < step); if (running() && i === step) el.setAttribute("aria-current", "step"); else el.removeAttribute("aria-current"); });
      get(".prep-particle-stage").setAttribute("aria-valuetext", get("[data-state]").textContent!);
      particles.update(complete ? 3 : step, running());
      const activity = get("[data-activity]");
      const open = new Set([...activity.querySelectorAll<HTMLDetailsElement>("details[open]")].map(d => d.dataset.thinkingKey ?? d.dataset.activityKey));
      activity.innerHTML = chatActivityMarkup(run?.activity, `terms-popup:${run?.id}`, open, undefined, { state: run?.state, grouped: true });
      get("[data-no-activity]").hidden = !!run?.activity.length;
      get("[data-latest]").textContent = run?.activity.length ? `${run.activity.length}개 활동` : "응답 대기";
    }
    const error = progress && !running() ? run?.error?.message : null;
    if (error) { get("[data-error]").textContent = error; get("[data-error]").hidden = false; }
    if (timer) clearInterval(timer);
    timer = dialog.open && progress && running() ? setInterval(clock, 1000) : undefined;
    clock();
  }
  async function open() {
    opener = document.activeElement as HTMLElement;
    const v = options.view(); if (!v) return;
    get("[data-title]").textContent = v.document.originalTitle || v.document.title;
    const basis = termSource(v);
    get("[data-source]").textContent = basis.text;
    get("[data-source-label]").textContent = basis.label;
    get("[data-materials]").textContent = "체크를 해제하면 이번 생성에서만 제외합니다. 문서 정보와 이 문서의 기존 용어는 함께 참고합니다.";
    get("[data-source-count]").textContent = `${Array.from(basis.text).length.toLocaleString()}자`;
    get("[data-error]").hidden = true;
    get("[data-context-disclosure]").hidden = true;
    get("[data-reference-disclosure]").hidden = true;
    dialog.dataset.mode = running() ? "progress" : "setup";
    if (!dialog.open) dialog.showModal();
    render();
    if (running()) return;
    get<HTMLSelectElement>("[data-agent]").disabled = true;
    get("[data-connection]").textContent = "연결 상태 확인 중…";
    excludedMaterialIds.clear(); excludedGlossaryIds.clear(); materialsReady = false;
    get<HTMLInputElement>("[data-glossary-enabled]").checked = true;
    get("[data-glossary-list]").innerHTML = "";
    get("[data-glossary-count]").textContent = "확인 중…";
    const serial = ++openSerial; loading = true; get<HTMLButtonElement>("[data-start]").disabled = true;
    try {
      const [nextConfig, nextProbes, materials, knowledge, terms] = await Promise.all([options.api.app.getConfig(), options.api.app.probeAgents(), options.api.knowledge.getMaterials(v.document.id), options.api.knowledge.get(), options.api.terms.list(v.document.id)]);
      if (serial !== openSerial || !dialog.open) return;
      if (!materials.ok) throw new Error(materials.error.message);
      if (!knowledge.ok) throw new Error(knowledge.error.message);
      if (!terms.ok) throw new Error(terms.error.message);
      const glossary = relatedTermGlossary(basis.text, knowledge.data.glossary, terms.data);
      const statusLabels: Record<string, string> = { draft: "미검토", reviewed: "검토됨", preferred: "권장 표기", allowed: "허용 표기", forbidden: "금지 표기" };
      get("[data-glossary-list]").innerHTML = glossary.length ? glossary.map(item => `<details class="term-context-item"><summary><input type="checkbox" data-glossary-id="${esc(item.id)}" aria-label="${esc(item.sourceForm)} 공통 용어 참고" checked><span class="term-context-mark" aria-hidden="true">›</span><span class="term-context-title">${esc(item.sourceForm)}${item.reading ? ` · ${esc(item.reading)}` : ""}</span><span class="term-context-origin">${esc(statusLabels[item.status] ?? item.status)}</span></summary><div class="term-context-body">${esc([item.translation ? `등록 번역어: ${item.translation}` : "", item.definition ? `기존 뜻풀이: ${item.definition}` : "", item.contextNote ? `문맥·적용 메모: ${item.contextNote}` : "", item.uncertainty ? `확인할 점: ${item.uncertainty}` : "", ...item.evidence.map(e => `근거: ${e.citation}${e.url ? ` (${e.url})` : ""}`)].filter(Boolean).join("\n\n") || "등록된 풀이가 없습니다.")}</div></details>`).join("") : '<p class="prep-model-hint">본문에 표기가 등장하는 공통 용어가 없습니다.</p>';
      glossaryCounts();
      const context = (materials.data.resolved ?? []).filter(item => item.included && item.source !== "comment_reference");
      get("[data-context-disclosure]").hidden = false;
      get("[data-context-count]").textContent = `${context.length}개`;
      get("[data-context-list]").innerHTML = context.length ? context.map(item => `<details class="term-context-item"><summary><input type="checkbox" data-material-id="${esc(item.id)}" aria-label="${esc(item.title)} 참고" ${item.included ? "checked" : "disabled"}><span class="term-context-mark" aria-hidden="true">›</span><span class="term-context-title">${esc(item.title)}</span><span class="term-context-origin">${item.reason === "current" ? "이 문서" : item.reason === "ancestor" ? "상위 문서" : "선택 자료"}</span></summary><div class="term-context-body">${esc([item.contentMd, item.conditionMd ? `적용 조건·예외: ${item.conditionMd}` : "", item.origin ? `근거 코멘트의 원래 구절: ${item.origin.quote}` : ""].filter(Boolean).join("\n\n"))}</div></details>`).join("") : '<p class="prep-model-hint">현재 문서에 적용된 문맥이 없습니다.</p>';
      const references = (materials.data.resolved ?? []).filter(item => item.source === "comment_reference");
      get("[data-reference-disclosure]").hidden = !references.length;
      get("[data-reference-count]").textContent = `${references.filter(item => item.included).length}개 적용`;
      get("[data-reference-list]").innerHTML = references.map(item => `<details class="term-context-item"><summary><input type="checkbox" data-material-id="${esc(item.id)}" aria-label="${esc(item.title)} 참고" ${item.included ? "checked" : "disabled"}><span class="term-context-mark" aria-hidden="true">›</span><span class="term-context-title">${esc(item.title)}</span><span class="term-context-origin">${item.included ? "적용 중" : item.reference?.needsReview || item.reference?.sourceChanged || item.reference?.sourceUnavailable ? "확인 필요 · 미적용" : "미적용"}</span></summary><div class="term-context-body">${esc([`원래 구절: ${item.origin?.quote ?? ""}`, `원본 코멘트: ${item.origin?.bodyMd ?? ""}`, item.contentMd ? `보충 메모: ${item.contentMd}` : "", item.conditionMd ? `적용 조건: ${item.conditionMd}` : ""].filter(Boolean).join("\n\n"))}</div></details>`).join("");
      materialsReady = true; materialCounts();
      config = nextConfig; probes = nextProbes;
    } catch (error) { get("[data-error]").textContent = String(error); get("[data-error]").hidden = false; }
    finally { if (serial === openSerial) { loading = false; get<HTMLSelectElement>("[data-agent]").disabled = false; settings(); } }
  }
  function close() { ++openSerial; dialog.close(); if (timer) clearInterval(timer); timer = undefined; if (opener?.isConnected) opener.focus(); }
  dialog.addEventListener("cancel", e => { e.preventDefault(); close(); });
  dialog.addEventListener("change", e => {
    if (running()) return;
    const checkbox = e.target as HTMLInputElement;
    if (checkbox.matches("[data-glossary-enabled]")) { glossaryCounts(); return; }
    if (checkbox.matches("[data-glossary-id]")) {
      if (checkbox.checked) excludedGlossaryIds.delete(checkbox.dataset.glossaryId!);
      else excludedGlossaryIds.add(checkbox.dataset.glossaryId!);
      checkbox.closest(".term-context-item")?.classList.toggle("is-excluded", !checkbox.checked);
      glossaryCounts(); return;
    }
    if (checkbox.matches("[data-material-id]")) {
      if (checkbox.checked) excludedMaterialIds.delete(checkbox.dataset.materialId!);
      else excludedMaterialIds.add(checkbox.dataset.materialId!);
      checkbox.closest(".term-context-item")?.classList.toggle("is-excluded", !checkbox.checked);
      const status = checkbox.closest("summary")?.querySelector<HTMLElement>(".term-context-origin");
      if (status) { status.dataset.originalLabel ??= status.textContent ?? ""; status.textContent = checkbox.checked ? status.dataset.originalLabel : "이번 생성에서 제외"; }
      materialCounts(); return;
    }
    if (!config) return;
    const el = e.target as HTMLSelectElement;
    if (el.matches("[data-agent]")) config.agentId = el.value as AppConfig["agentId"];
    else if (el.dataset.prepModelSetting) changePrepModelSetting(config, probe(), config.agentId, el.dataset.prepModelSetting, el.value);
    settings();
  });
  dialog.addEventListener("click", e => {
    const el = e.target as Element;
    if (el.matches("[data-material-id],[data-glossary-id],[data-glossary-enabled]")) { e.stopPropagation(); return; }
    if (el.closest("[data-close]")) close();
    if (el.closest("[data-back]")) { dialog.dataset.mode = "setup"; get("[data-error]").hidden = true; settings(); render(); }
    if (el.closest("[data-start]")) void execute();
    if (el.closest("[data-cancel]") && !canceling) { canceling = true; render(); void options.cancel().catch(error => { get("[data-error]").textContent = String(error); get("[data-error]").hidden = false; }).finally(() => { canceling = false; render(); }); }
  });
  async function execute() {
    if (!config || !materialsReady || loading || running()) return;
    submitting = true; run = null; startedAt = Date.now(); dialog.dataset.mode = "progress"; get("[data-error]").hidden = true; render();
    try {
      const current = await options.api.app.getConfig();
      await options.api.app.setConfig({ agentId: config.agentId, agentModels: { ...current.agentModels, [config.agentId]: config.agentModels[config.agentId] } });
      await options.start([...excludedMaterialIds], { enabled: get<HTMLInputElement>("[data-glossary-enabled]").checked, excludedIds: [...excludedGlossaryIds] });
    } catch (error) { get("[data-error]").textContent = error instanceof Error ? error.message : String(error); get("[data-error]").hidden = false; }
    finally { submitting = false; render(); }
  }
  return {
    open,
    update(next: TermExtractionRun | null, nextStarting: boolean) {
      if (nextStarting && !starting) startedAt = Date.now();
      if (run?.state === "running" && next?.state !== "running") endedAt = Date.now();
      if (next?.startedAt) startedAt = Date.parse(next.startedAt);
      if (next?.completedAt) endedAt = Date.parse(next.completedAt);
      run = next; starting = nextStarting; render();
    },
  };
}
