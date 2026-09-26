import { fixedGeminiEffort } from "../../shared/agent-model-preferences";
import { alignmentSettingsMarkup, changeAlignmentSetting } from "./alignment-settings-ui";
import { t, ui, uiText } from "./i18n";
import { previewNotificationSound } from "./notification-sounds";
import { BUNDLED_SKILLS } from "@munhae/db-sqlite/bundled-skills";
import { mountAccount } from "./account-ui";
import type { AgentProbe, AppConfig, DocumentListItem, HomeView, PluginsView, TranslationSkill } from "../../shared/munhae-api";
import {
  bindSidebar,
  defaultSidebarTree,
  esc,
  go,
  initShell,
  must,
  notify,
  renderSidebar,
  setAgentChrome,
  setSidebarProject,
} from "./shared";

type AgentId = AppConfig["agentId"];
type SectionId = "account" | "models" | "plugins" | "general";

const shell = initShell({ page: "settings", selfTitle: t("설정") });
const api = shell.api;
let accountPanel: ReturnType<typeof mountAccount> | undefined;
let activeSection: SectionId | undefined;

let config: AppConfig | null = null;
let agents: AgentProbe[] = [];
let agentProbePending = false;
let agentProbeFailed = false;
let hasFreshAgentProbes = false;
let docs: DocumentListItem[] = [];
let saveRevision = 0;
let saveChain: Promise<void> = Promise.resolve();
let plugins: PluginsView | null = null;
let pluginBusy = false;
let catalog: TranslationSkill[] | null = null;
let catalogError: string | null = null;
const loginInstructions = new Map<AgentId, { command: string; detail: string }>();

function tree() {
  return defaultSidebarTree(docs);
}

window.addEventListener("munhae:document-created", (event) => {
  docs = (event as CustomEvent<HomeView>).detail.documents;
  renderSidebar(tree());
});

function agentName(agentId: AgentId): string {
  return agentId === "antigravity" ? "Antigravity CLI" : agentId === "codex" ? "Codex CLI" : "Claude CLI";
}

function providerName(agentId: AgentId): string {
  return agentId === "antigravity" ? t("Google 공식 CLI") : agentId === "codex" ? t("OpenAI 공식 CLI") : t("Anthropic 공식 CLI");
}

function agentMark(agentId: AgentId): string {
  return agentId === "antigravity" ? "Ag" : agentId === "codex" ? "Cx" : "Cl";
}

function statusMeta(probe: AgentProbe | undefined): { label: string; cls: string } {
  if (!probe) return { label: agentProbePending ? t("확인 중") : t("확인 불가"), cls: "" };
  if (!probe.installed) return { label: t("미설치"), cls: "warn" };
  if (probe.loggedIn === true) return { label: t("로그인됨"), cls: "ok" };
  if (probe.loggedIn === false) return { label: t("로그인 필요"), cls: "warn" };
  return { label: t("설치됨"), cls: "" };
}

function agentDescription(probe: AgentProbe | undefined): string {
  if (!probe) return agentProbePending ? t("AI 연결 상태를 확인하고 있습니다.") : t("CLI 설치 상태를 확인하지 못했습니다.");
  if (!probe.installed) return t("이 기기의 PATH에서 실행 파일을 찾지 못했습니다.");
  if (probe.agentId === "antigravity" && probe.modelSource !== "live") return t("agy에서 로그인하고 모델을 선택하세요. 실행할 때 연결 상태를 확인합니다.");
  if (probe.modelSource === "live") return t("사용 가능한 모델과 실행 옵션을 CLI에서 확인했습니다.");
  return t("CLI가 제공하는 기본 모델 또는 호환 모델을 사용합니다.");
}

function optionHtml(id: string, label: string, selected: string | null): string {
  return `<option value="${esc(id)}"${id === selected ? " selected" : ""}>${esc(label)}</option>`;
}

function uniqueOptions(options: ReadonlyArray<{ id: string; label: string }>): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  return options.filter((option) => {
    if (!option.id || seen.has(option.id)) return false;
    seen.add(option.id);
    return true;
  });
}

function modelOptions(probe: AgentProbe | undefined, selected: string): Array<{ id: string; label: string }> {
  const options = uniqueOptions([
    { id: "default", label: t("CLI 기본값") },
    ...(probe?.models ?? []).map((model) => ({
      id: model.id,
      label: model.id === "default" ? t("CLI 기본값") : model.label,
    })),
  ]);
  if (selected && !options.some((option) => option.id === selected)) {
    options.push({ id: selected, label: ui`${selected} · 저장된 값` });
  }
  return options;
}

function capabilityOptions(
  probe: AgentProbe | undefined,
  modelId: string,
  kind: "reasoning" | "tier",
): Array<{ id: string; label: string }> {
  const model = probe?.models.find((item) => item.id === modelId);
  if (kind === "reasoning") return uniqueOptions(model?.reasoningOptions ?? probe?.reasoningOptions ?? []);
  return uniqueOptions(model?.serviceTierOptions ?? probe?.serviceTierOptions ?? []);
}

function selectOptions(
  options: ReadonlyArray<{ id: string; label: string }>,
  selected: string | null,
  firstLabel: string,
): string {
  const all = [{ id: "", label: firstLabel }, ...options];
  if (selected && !all.some((option) => option.id === selected)) {
    all.push({ id: selected, label: ui`${selected} · 저장된 값` });
  }
  return all.map((option) => optionHtml(option.id, option.label, selected)).join("");
}

function renderAgentCard(agentId: AgentId): string {
  if (!config) return "";
  const probe = agents.find((item) => item.agentId === agentId);
  const prefs = config.agentModels[agentId];
  const selected = config.agentId === agentId;
  const status = statusMeta(probe);
  const models = modelOptions(probe, prefs.model || "default");
  const model = probe?.models.find((item) => item.id === prefs.model);
  const modelLabel = prefs.model === "default" ? t("CLI 기본값") : (model?.label ?? prefs.model);
  const fixedEffort = agentId === "antigravity" ? fixedGeminiEffort(prefs.model) : null;
  const reasoning = fixedEffort ? [{ id: fixedEffort, label: fixedEffort }] : capabilityOptions(probe, prefs.model, "reasoning");
  const tiers = capabilityOptions(probe, prefs.model, "tier");
  const instruction = loginInstructions.get(agentId);
  const modelDisabled = probe ? !probe.installed || !probe.capabilities.modelSelection : false;
  const reasoningDisabled = !!fixedEffort || (probe ? !probe.installed || !probe.capabilities.reasoningEffort : false);
  const tierDisabled = agentId === "claude" || (probe ? !probe.installed || !probe.capabilities.serviceTier : false);
  const version = probe?.version ? `<span class="tag tag-line mono">${esc(probe.version)}</span>` : "";

  return `<article class="cli-card${selected ? " is-selected" : ""}${probe && !probe.installed ? " is-unavailable" : ""}" data-agent-card="${agentId}">
    <label class="cli-pick">
      <input type="radio" name="defaultAgent" value="${agentId}"${selected ? " checked" : ""}${probe && !probe.installed ? " disabled" : ""}>
      <span class="cli-mark ${agentId}" aria-hidden="true">${agentMark(agentId)}</span>
      <span class="cli-copy"><b>${agentName(agentId)} <span class="provider-name">· ${providerName(agentId)}</span></b><p>${esc(agentDescription(probe))}</p></span>
      <span class="cli-meta">${selected ? uiText('<span class="tag tag-draft">기본</span>') : ""}${version}<span class="cli-status"><i class="dot ${status.cls}"></i>${status.label}</span></span>
    </label>
    ${selected ? ui`<div class="cli-controls">
      <div class="field"><label for="model-${agentId}">모델</label><select class="select mono" id="model-${agentId}" data-agent-model="${agentId}"${modelDisabled ? " disabled" : ""}>${models.map((option) => optionHtml(option.id, option.label, prefs.model)).join("")}</select></div>
      <div class="field"><label for="reasoning-${agentId}">추론 강도</label><select class="select" id="reasoning-${agentId}" data-agent-reasoning="${agentId}"${reasoningDisabled ? " disabled" : ""}>${selectOptions(reasoning, prefs.reasoning, fixedEffort ? t("모델에 포함된 강도") : reasoningDisabled ? t("지원하지 않음") : t("CLI 기본값"))}</select></div>
      <div class="field"><label for="tier-${agentId}">서비스 등급</label><select class="select" id="tier-${agentId}" data-agent-tier="${agentId}"${tierDisabled ? " disabled" : ""}>${selectOptions(tiers, prefs.serviceTier, tierDisabled ? t("지원하지 않음") : t("CLI 기본값"))}</select></div>
    </div>
    <div class="cli-actions">
      <span class="login-instruction">현재 모델: <b>${esc(modelLabel)}</b>${instruction ? `<code class="mono">${esc(instruction.command)}</code><span>${esc(instruction.detail)}</span>` : ""}</span>
      <button class="btn btn-sm" type="button" data-login-agent="${agentId}">로그인 안내</button>
    </div>` : ""}
  </article>`;
}

function renderAgents(): void {
  if (!config) return;
  must("#cliList").innerHTML = agentProbePending && !agents.length
    ? uiText('<p class="empty" role="status">AI 연결 상태를 확인하고 있습니다.</p>')
    : (["claude", "codex", "antigravity"] as const).map(renderAgentCard).join("") + alignmentSettingsMarkup(config, agents, "settings-alignment");
  const installed = agents.filter((agent) => agent.installed).length;
  must("#installedCount").textContent = agentProbePending
    ? agents.length ? ui`${installed}개 설치됨 · 확인 중` : t("확인 중")
    : agentProbeFailed ? t("확인 실패") : agents.length ? ui`${installed}개 설치됨` : t("상태 확인 불가");
  const selected = agents.find((agent) => agent.agentId === config?.agentId);
  const selectedStatus = statusMeta(selected);
  must("#settingsAgent").innerHTML = `<i class="dot ${selectedStatus.cls}"></i>${esc(agentName(config.agentId))} · ${esc(selectedStatus.label)}`;
  setAgentChrome(agents, undefined, config.agentId);
}

function setSaveState(label: string, state: "idle" | "saved" | "error" = "idle"): void {
  const el = must("#saveState");
  el.textContent = label;
  el.classList.toggle("is-saved", state === "saved");
  el.classList.toggle("is-error", state === "error");
}

function scheduleSave(): void {
  if (!config) return;
  const revision = ++saveRevision;
  setSaveState(t("저장 중…"));
  saveChain = saveChain.then(async () => {
    if (!config || revision !== saveRevision) return;
    const snapshot: AppConfig = {
      language: config.language,
      translationLanguage: config.translationLanguage,
      agentId: config.agentId,
      alignment: config.alignment ? { ...config.alignment } : null,
      agentModels: {
        codex: { ...config.agentModels.codex },
        claude: { ...config.agentModels.claude },
        antigravity: { ...config.agentModels.antigravity },
      },
      showWelcomeOnLaunch: config.showWelcomeOnLaunch,
      backgroundMusicEnabled: config.backgroundMusicEnabled,
      backgroundMusicVolume: config.backgroundMusicVolume,
      notificationSoundEnabled: config.notificationSoundEnabled,
      notificationSoundVolume: config.notificationSoundVolume,
    };
    try {
      const saved = await api.app.setConfig(snapshot);
      if (revision !== saveRevision) return;
      config = saved;
      if (saved.language !== document.documentElement.lang) { location.reload(); return; }
      setSaveState(t("저장됨"), "saved");
      window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: saved }));
      renderAgents();
    } catch (error) {
      if (revision !== saveRevision) return;
      try { config = await api.app.getConfig(); } catch { /* Keep the current form if reading settings also fails. */ }
      if (config) config.language = document.documentElement.lang === "en" ? "en" : "ko";
      must<HTMLSelectElement>("#translationLanguage").value = config?.translationLanguage ?? "ko";
      must<HTMLSelectElement>("#displayLanguage").value = config?.language ?? "ko";
      setSaveState(t("저장 실패"), "error");
      notify(error instanceof Error ? error.message : t("설정을 저장하지 못했습니다."), t("설정"));
    }
  });
}

function skillVersion(content: string): string {
  return content.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? "—";
}

function skillSource(title: string, content: string): string {
  return ui`<details class="skill-details"><summary>SKILL.md 전체 내용</summary><pre class="skill-source" tabindex="0" aria-label="${esc(title)} 스킬 원문"><code>${esc(content)}</code></pre></details>`;
}

function renderAlignmentSkill(): void {
  const content = BUNDLED_SKILLS["align-translation"];
  must("#alignmentSkill").innerHTML = ui`<article class="skill-card" aria-labelledby="skill-align-translation">
    <div class="skill-card-head"><div><p class="skill-timing">두 번째 요청 · 번역 저장 후</p><h2 id="skill-align-translation">원문 연결</h2></div><span class="tag tag-line mono">v${esc(skillVersion(content))}</span></div>
    <p class="skill-description">저장된 번역을 바꾸지 않고 번역 문장과 정확한 원문 범위를 연결합니다. 불확실한 대응은 확인이 필요하다고 표시합니다.</p>
    <p class="skill-name mono">align-translation</p>
    ${skillSource(t("원문 연결"), content)}
  </article>`;
}

type PluginCard = {
  value: string;
  title: string;
  origin: string;
  description: string;
  version: string | null;
  content: string;
  applied: boolean;
  note?: string;
  removable?: string;
};

function pluginCard(card: PluginCard): string {
  const disabled = !plugins?.projectOpen || pluginBusy;
  return `<article class="cli-card plugin-card${card.applied ? " is-selected" : ""}">
    <label class="cli-pick">
      <input type="radio" name="translationPlugin" value="${esc(card.value)}"${card.applied ? " checked" : ""}${disabled ? " disabled" : ""}>
      <span class="cli-copy"><b>${esc(card.title)} <span class="provider-name">· ${esc(card.origin)}</span></b><p>${esc(card.description)}</p></span>
      <span class="cli-meta">${card.applied ? uiText('<span class="tag tag-draft">적용됨</span>') : ""}${card.note ? `<span class="tag tag-warn">${esc(card.note)}</span>` : ""}${card.version ? `<span class="tag tag-line mono">v${esc(card.version)}</span>` : ""}</span>
    </label>
    <div class="cli-actions plugin-actions">${skillSource(card.title, card.content)}${card.removable ? ui`<button class="btn btn-sm" type="button" data-remove-plugin="${esc(card.removable)}"${pluginBusy ? " disabled" : ""}>삭제</button>` : ""}</div>
  </article>`;
}

function renderPlugins(): void {
  const list = must("#translationPlugins");
  if (!plugins) {
    list.innerHTML = uiText('<p class="empty" role="status">플러그인을 불러오는 중입니다.</p>');
    return;
  }
  const { installed, applied, projectOpen } = plugins;
  // A project copy that no longer matches this device's library stays visible and selected.
  const matching = applied ? installed.find((plugin) => plugin.name === applied.name && plugin.hash === applied.hash) : undefined;
  const base = BUNDLED_SKILLS["translate-document"];
  const cards: PluginCard[] = [{
    value: "default",
    title: t("전문 번역"),
    origin: t("기본 제공"),
    description: t("원문 전체를 읽고 선택한 번역 언어로 문단을 구성합니다. 번역을 제출하기 전에 누락·용어·불확실성을 검토합니다."),
    version: skillVersion(base),
    content: base,
    applied: projectOpen && !applied,
  }];
  if (applied && !matching) cards.push({
    value: "project",
    title: applied.name,
    origin: t("프로젝트에 저장됨"),
    description: applied.description,
    version: applied.version,
    content: applied.content,
    applied: true,
    note: installed.some((plugin) => plugin.name === applied.name) ? t("설치본과 다름") : t("이 기기에 설치되지 않음"),
  });
  for (const plugin of installed) cards.push({
    value: `installed:${plugin.name}`,
    title: plugin.name,
    origin: t("설치됨"),
    description: plugin.description,
    version: plugin.version,
    content: plugin.content,
    applied: plugin === matching,
    removable: plugin.name,
  });
  list.innerHTML = cards.map(pluginCard).join("");
  must<HTMLButtonElement>("#btnInstallPlugin").disabled = pluginBusy;
  must("#translationPluginsNote").textContent = projectOpen
    ? t("이 프로젝트에서 새 번역을 만들 때 쓸 지침을 하나 고릅니다. 이미 만든 번역은 바뀌지 않습니다.")
    : t("프로젝트를 열면 적용할 지침을 고를 수 있습니다.");
  renderCatalog();
}

function renderCatalog(): void {
  const list = must("#catalogPlugins");
  if (catalogError) {
    list.innerHTML = `<p class="empty" role="status">${esc(catalogError)} ${uiText('<button class="btn btn-sm" type="button" data-retry-catalog>다시 시도</button>')}</p>`;
    return;
  }
  if (!catalog) {
    list.innerHTML = uiText('<p class="empty" role="status">추천 플러그인을 불러오는 중입니다.</p>');
    return;
  }
  if (!catalog.length) {
    list.innerHTML = uiText('<p class="empty" role="status">아직 추천 플러그인이 없습니다.</p>');
    return;
  }
  const installed = new Map((plugins?.installed ?? []).map((plugin) => [plugin.name, plugin]));
  list.innerHTML = catalog.map((skill) => {
    const local = installed.get(skill.name);
    const action = local?.hash === skill.hash
      ? uiText('<span class="tag tag-plain">설치됨</span>')
      : `<button class="btn btn-sm" type="button" data-install-catalog="${esc(skill.name)}"${pluginBusy ? " disabled" : ""}>${local ? t("업데이트") : t("설치")}</button>`;
    return `<article class="cli-card plugin-card">
      <div class="cli-pick catalog-pick">
        <span class="cli-copy"><b>${esc(skill.name)}</b><p>${esc(skill.description)}</p></span>
        <span class="cli-meta">${skill.version ? `<span class="tag tag-line mono">v${esc(skill.version)}</span>` : ""}${action}</span>
      </div>
      <div class="cli-actions plugin-actions">${skillSource(skill.name, skill.content)}</div>
    </article>`;
  }).join("");
}

async function loadCatalog(): Promise<void> {
  catalog = null;
  catalogError = null;
  renderCatalog();
  const result = await api.plugins.catalog();
  if (result.ok) catalog = result.data;
  else catalogError = result.error.message;
  renderCatalog();
}

async function loadPlugins(): Promise<void> {
  const result = await api.plugins.list();
  if (result.ok) plugins = result.data;
  else notify(result.error.message, t("플러그인"));
  renderPlugins();
}

async function pluginAction<T>(action: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string } }>, done: (data: T) => string | null): Promise<void> {
  if (pluginBusy) return;
  pluginBusy = true;
  renderPlugins();
  try {
    const result = await action();
    if (!result.ok) notify(result.error.message, t("플러그인"));
    else {
      const message = done(result.data);
      if (message) notify(message, t("플러그인"));
    }
  } finally {
    pluginBusy = false;
    await loadPlugins();
  }
}

function setSection(section: SectionId): void {
  if (activeSection === "account" && section !== "account") accountPanel?.deactivate();
  activeSection = section;
  if (section === "account" && !accountPanel) accountPanel = mountAccount(api, { embedded: true });
  document.querySelectorAll<HTMLElement>("[data-settings-section]").forEach((button) => {
    const current = button.dataset.settingsSection === section;
    button.classList.toggle("is-current", current);
    if (current) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  const pages: Record<SectionId, string> = { account: "#settingsAccount", models: "#settingsModels", plugins: "#settingsPlugins", general: "#settingsGeneral" };
  for (const [id, selector] of Object.entries(pages)) {
    const page = must(selector);
    page.classList.toggle("is-open", section === id);
    page.hidden = section !== id;
  }
  if (section === "account") accountPanel?.activate();
  history.replaceState(null, "", section === "models" ? "settings.html" : `settings.html#${section}`);
  must("#saveState").hidden = section === "account" || section === "plugins";
  must("#settingsPath").textContent = section === "account" ? t("문해 계정")
    : section === "plugins" ? t("설치는 이 기기 · 적용은 프로젝트에 저장") : t("앱 설정 · 프로젝트 밖에 저장");
}

function sectionFromHash(): SectionId {
  if (location.hash === "#plugins" || location.hash === "#skills") return "plugins";
  return location.hash === "#account" ? "account" : location.hash === "#general" ? "general" : "models";
}

window.addEventListener("hashchange", () => setSection(sectionFromHash()));

async function rescanAgents(showFailure = true): Promise<void> {
  if (agentProbePending) return;
  agentProbePending = true;
  agentProbeFailed = false;
  const button = must<HTMLButtonElement>("#btnRescan");
  button.disabled = true;
  button.textContent = t("확인 중…");
  renderAgents();
  try {
    agents = await api.app.probeAgents();
    hasFreshAgentProbes = true;
  } catch (error) {
    agentProbeFailed = true;
    if (showFailure) notify(error instanceof Error ? error.message : t("CLI 상태를 확인하지 못했습니다."), t("로컬 CLI"));
  } finally {
    agentProbePending = false;
    button.disabled = false;
    button.textContent = t("다시 확인");
    renderAgents();
  }
}

async function showLoginInstruction(agentId: AgentId, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = t("확인 중…");
  try {
    const instruction = await api.app.getLoginInstruction(agentId);
    loginInstructions.set(agentId, {
      command: instruction.displayCommand,
      detail: instruction.available
        ? t("이 명령을 터미널에서 실행해 CLI 로그인을 완료하세요.")
        : ui`${instruction.detail} CLI를 설치한 뒤 이 명령을 실행하세요.`,
    });
    renderAgents();
  } catch (error) {
    notify(error instanceof Error ? error.message : t("로그인 안내를 불러오지 못했습니다."), agentName(agentId));
  } finally {
    button.disabled = false;
    button.textContent = t("로그인 안내");
  }
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const sectionButton = target.closest<HTMLElement>("[data-settings-section]");
  if (sectionButton?.dataset.settingsSection) {
    setSection(sectionButton.dataset.settingsSection as SectionId);
    return;
  }
  const loginButton = target.closest<HTMLButtonElement>("[data-login-agent]");
  if (loginButton?.dataset.loginAgent) {
    void showLoginInstruction(loginButton.dataset.loginAgent as AgentId, loginButton);
    return;
  }
  const catalogButton = target.closest<HTMLButtonElement>("[data-install-catalog]");
  const catalogName = catalogButton?.dataset.installCatalog;
  if (catalogName) {
    void pluginAction(() => api.plugins.installCatalog(catalogName), (plugin) => ui`${plugin.name} 플러그인을 설치했습니다.`);
    return;
  }
  if (target.closest("[data-retry-catalog]")) {
    void loadCatalog();
    return;
  }
  const removeButton = target.closest<HTMLButtonElement>("[data-remove-plugin]");
  const removeName = removeButton?.dataset.removePlugin;
  if (removeName) {
    void pluginAction(() => api.plugins.remove(removeName), () => ui`${removeName} 플러그인을 이 기기에서 삭제했습니다.`);
  }
});

must("#btnInstallPlugin").addEventListener("click", () => {
  void pluginAction(() => api.plugins.install(), (plugin) => plugin ? ui`${plugin.name} 플러그인을 설치했습니다.` : null);
});

must("#translationPlugins").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== "translationPlugin" || target.value === "project") return;
  const name = target.value === "default" ? null : target.value.slice("installed:".length);
  void pluginAction(() => api.plugins.apply(name), () => name
    ? ui`이 프로젝트의 번역에 ${name} 플러그인을 적용했습니다.`
    : t("이 프로젝트의 번역을 기본 지침으로 되돌렸습니다."));
});

must("#cliList").addEventListener("change", (event) => {
  if (!config) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.dataset.alignmentSetting && changeAlignmentSetting(config, agents, target.dataset.alignmentSetting, target.value)) {
    renderAgents(); scheduleSave(); return;
  }
  if (target instanceof HTMLInputElement && target.name === "defaultAgent") {
    config.agentId = target.value as AgentId;
    renderAgents();
    scheduleSave();
    return;
  }
  const modelAgent = target.dataset.agentModel as AgentId | undefined;
  if (modelAgent) {
    config.agentModels[modelAgent].model = target.value || "default";
    if (modelAgent === "antigravity") config.agentModels.antigravity.reasoning = fixedGeminiEffort(target.value);
    renderAgents();
    scheduleSave();
    return;
  }
  const reasoningAgent = target.dataset.agentReasoning as AgentId | undefined;
  if (reasoningAgent) {
    config.agentModels[reasoningAgent].reasoning = target.value || null;
    scheduleSave();
    return;
  }
  const tierAgent = target.dataset.agentTier as AgentId | undefined;
  if (tierAgent) {
    config.agentModels[tierAgent].serviceTier = target.value || null;
    scheduleSave();
  }
});

must<HTMLSelectElement>("#translationLanguage").addEventListener("change", event => {
  if (!config) return;
  config.translationLanguage = (event.currentTarget as HTMLSelectElement).value === "en" ? "en" : "ko";
  scheduleSave();
});

must<HTMLSelectElement>("#displayLanguage").addEventListener("change", event => {
  if (!config) return;
  config.language = (event.currentTarget as HTMLSelectElement).value === "en" ? "en" : "ko";
  scheduleSave();
});

must<HTMLInputElement>("#showWelcome").addEventListener("change", (event) => {
  if (!config) return;
  config.showWelcomeOnLaunch = (event.currentTarget as HTMLInputElement).checked;
  scheduleSave();
});

must<HTMLInputElement>("#backgroundMusicVolume").addEventListener("input", (event) => {
  if (!config) return;
  config.backgroundMusicVolume = Number((event.currentTarget as HTMLInputElement).value);
  must<HTMLOutputElement>("#backgroundMusicVolumeValue").value = `${config.backgroundMusicVolume}%`;
  window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: config }));
  scheduleSave();
});

must<HTMLInputElement>("#backgroundMusic").addEventListener("change", (event) => {
  if (!config) return;
  config.backgroundMusicEnabled = (event.currentTarget as HTMLInputElement).checked;
  window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: config }));
  scheduleSave();
});

must<HTMLInputElement>("#notificationSound").addEventListener("change", event => {
  if (!config) return;
  config.notificationSoundEnabled = (event.currentTarget as HTMLInputElement).checked;
  window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: config }));
  scheduleSave();
});
must<HTMLInputElement>("#notificationVolume").addEventListener("input", event => {
  if (!config) return;
  config.notificationSoundVolume = Number((event.currentTarget as HTMLInputElement).value);
  must<HTMLOutputElement>("#notificationVolumeValue").value = `${config.notificationSoundVolume}%`;
  window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: config }));
  scheduleSave();
});
must("#previewChatSound").addEventListener("click", () => previewNotificationSound("chat"));
must("#previewStageSound").addEventListener("click", () => previewNotificationSound("stage"));

must("#btnRescan").addEventListener("click", () => void rescanAgents());

async function load(): Promise<void> {
  // CLI probing can take seconds. Show local settings and cached results first.
  void rescanAgents(false);
  const [loadedConfig, project] = await Promise.all([
    api.app.getConfig(),
    api.project.getCurrent().catch(() => null),
  ]);
  config = loadedConfig;
  must<HTMLSelectElement>("#translationLanguage").value = config.translationLanguage;
  must<HTMLSelectElement>("#translationLanguage").disabled = false;
  must<HTMLSelectElement>("#displayLanguage").value = config.language;
  must<HTMLSelectElement>("#displayLanguage").disabled = false;
  must<HTMLInputElement>("#notificationSound").checked = config.notificationSoundEnabled;
  must<HTMLInputElement>("#notificationVolume").value = String(config.notificationSoundVolume);
  must<HTMLOutputElement>("#notificationVolumeValue").value = `${config.notificationSoundVolume}%`;
  for (const id of ["#notificationSound", "#notificationVolume", "#previewChatSound", "#previewStageSound"]) must<HTMLInputElement>(id).disabled = false;
  must<HTMLInputElement>("#backgroundMusicVolume").value = String(config.backgroundMusicVolume);
  must<HTMLInputElement>("#backgroundMusicVolume").disabled = false;
  must<HTMLOutputElement>("#backgroundMusicVolumeValue").value = `${config.backgroundMusicVolume}%`;
  must<HTMLInputElement>("#backgroundMusic").checked = config.backgroundMusicEnabled;
  must<HTMLInputElement>("#backgroundMusic").disabled = false;
  must<HTMLInputElement>("#showWelcome").checked = config.showWelcomeOnLaunch;
  if (project) {
    setSidebarProject(project);
    document.querySelector(".titlebar .tb-c small")!.textContent = ui`${project.title} · 앱 전체`;
    const home = await api.home.get();
    if (home.ok) {
      docs = home.data.documents;
      // A fast live result must not be overwritten by an older home snapshot.
      if (!hasFreshAgentProbes) agents = home.data.agents;
    }
  }
  setAgentChrome(agents, undefined, config.agentId);
  renderSidebar(tree());
  bindSidebar(
    (documentNodeId) => go("editor", documentNodeId),
    tree,
  );
  renderAgents();
  setSaveState(t("저장됨"), "saved");
}

renderAlignmentSkill();
renderPlugins();
setSection(sectionFromHash());
void loadPlugins();
void loadCatalog();
await load();
