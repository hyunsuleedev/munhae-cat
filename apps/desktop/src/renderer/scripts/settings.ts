import { previewNotificationSound } from "./notification-sounds";
import { BUNDLED_SKILLS } from "@munhae/db-sqlite/bundled-skills";
import { mountAccount } from "./account-ui";
import type { AgentProbe, AppConfig, DocumentListItem, HomeView } from "../../shared/munhae-api";
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
} from "./shared";

type AgentId = AppConfig["agentId"];
type SectionId = "account" | "models" | "skills" | "general";

const shell = initShell({ page: "settings", selfTitle: "설정" });
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
  return agentId === "antigravity" ? "Google 공식 CLI" : agentId === "codex" ? "OpenAI 공식 CLI" : "Anthropic 공식 CLI";
}

function agentMark(agentId: AgentId): string {
  return agentId === "antigravity" ? "Ag" : agentId === "codex" ? "Cx" : "Cl";
}

function statusMeta(probe: AgentProbe | undefined): { label: string; cls: string } {
  if (!probe) return { label: agentProbePending ? "확인 중" : "확인 불가", cls: "" };
  if (!probe.installed) return { label: "미설치", cls: "warn" };
  if (probe.loggedIn === true) return { label: "로그인됨", cls: "ok" };
  if (probe.loggedIn === false) return { label: "로그인 필요", cls: "warn" };
  return { label: "설치됨", cls: "" };
}

function agentDescription(probe: AgentProbe | undefined): string {
  if (!probe) return agentProbePending ? "AI 연결 상태를 확인하고 있습니다." : "CLI 설치 상태를 확인하지 못했습니다.";
  if (!probe.installed) return "이 기기의 PATH에서 실행 파일을 찾지 못했습니다.";
  if (probe.agentId === "antigravity" && probe.modelSource !== "live") return "agy에서 로그인하고 모델을 선택하세요. 실행할 때 연결 상태를 확인합니다.";
  if (probe.modelSource === "live") return "사용 가능한 모델과 실행 옵션을 CLI에서 확인했습니다.";
  return "CLI가 제공하는 기본 모델 또는 호환 모델을 사용합니다.";
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
    { id: "default", label: "CLI 기본값" },
    ...(probe?.models ?? []).map((model) => ({
      id: model.id,
      label: model.id === "default" ? "CLI 기본값" : model.label,
    })),
  ]);
  if (selected && !options.some((option) => option.id === selected)) {
    options.push({ id: selected, label: `${selected} · 저장된 값` });
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
    all.push({ id: selected, label: `${selected} · 저장된 값` });
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
  const modelLabel = prefs.model === "default" ? "CLI 기본값" : (model?.label ?? prefs.model);
  const reasoning = capabilityOptions(probe, prefs.model, "reasoning");
  const tiers = capabilityOptions(probe, prefs.model, "tier");
  const instruction = loginInstructions.get(agentId);
  const modelDisabled = probe ? !probe.installed || !probe.capabilities.modelSelection : false;
  const reasoningDisabled = probe ? !probe.installed || !probe.capabilities.reasoningEffort : false;
  const tierDisabled = agentId === "claude" || (probe ? !probe.installed || !probe.capabilities.serviceTier : false);
  const version = probe?.version ? `<span class="tag tag-line mono">${esc(probe.version)}</span>` : "";

  return `<article class="cli-card${selected ? " is-selected" : ""}${probe && !probe.installed ? " is-unavailable" : ""}" data-agent-card="${agentId}">
    <label class="cli-pick">
      <input type="radio" name="defaultAgent" value="${agentId}"${selected ? " checked" : ""}${probe && !probe.installed ? " disabled" : ""}>
      <span class="cli-mark ${agentId}" aria-hidden="true">${agentMark(agentId)}</span>
      <span class="cli-copy"><b>${agentName(agentId)} <span class="provider-name">· ${providerName(agentId)}</span></b><p>${esc(agentDescription(probe))}</p></span>
      <span class="cli-meta">${selected ? '<span class="tag tag-draft">기본</span>' : ""}${version}<span class="cli-status"><i class="dot ${status.cls}"></i>${status.label}</span></span>
    </label>
    ${selected ? `<div class="cli-controls">
      <div class="field"><label for="model-${agentId}">모델</label><select class="select mono" id="model-${agentId}" data-agent-model="${agentId}"${modelDisabled ? " disabled" : ""}>${models.map((option) => optionHtml(option.id, option.label, prefs.model)).join("")}</select></div>
      <div class="field"><label for="reasoning-${agentId}">추론 강도</label><select class="select" id="reasoning-${agentId}" data-agent-reasoning="${agentId}"${reasoningDisabled ? " disabled" : ""}>${selectOptions(reasoning, prefs.reasoning, reasoningDisabled ? "지원하지 않음" : "CLI 기본값")}</select></div>
      <div class="field"><label for="tier-${agentId}">서비스 등급</label><select class="select" id="tier-${agentId}" data-agent-tier="${agentId}"${tierDisabled ? " disabled" : ""}>${selectOptions(tiers, prefs.serviceTier, tierDisabled ? "지원하지 않음" : "CLI 기본값")}</select></div>
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
    ? '<p class="empty" role="status">AI 연결 상태를 확인하고 있습니다.</p>'
    : (["claude", "codex", "antigravity"] as const).map(renderAgentCard).join("");
  const installed = agents.filter((agent) => agent.installed).length;
  must("#installedCount").textContent = agentProbePending
    ? agents.length ? `${installed}개 설치됨 · 확인 중` : "확인 중"
    : agentProbeFailed ? "확인 실패" : agents.length ? `${installed}개 설치됨` : "상태 확인 불가";
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
  setSaveState("저장 중…");
  saveChain = saveChain.then(async () => {
    if (!config || revision !== saveRevision) return;
    const snapshot: AppConfig = {
      agentId: config.agentId,
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
      setSaveState("저장됨", "saved");
      window.dispatchEvent(new CustomEvent<AppConfig>("munhae:config-changed", { detail: saved }));
      renderAgents();
    } catch (error) {
      if (revision !== saveRevision) return;
      setSaveState("저장 실패", "error");
      notify(error instanceof Error ? error.message : "설정을 저장하지 못했습니다.", "설정");
    }
  });
}

function renderSkills(): void {
  const descriptions = {
    "translate-document": {
      title: "전문 번역",
      description: "원문 전체를 읽고 의미 흐름에 따라 한국어 문단을 구성합니다. 번역을 제출하기 전에 누락·용어·불확실성을 검토합니다.",
      timing: "첫 번째 요청 · 번역 생성",
    },
    "align-translation": {
      title: "원문 연결",
      description: "저장된 번역을 바꾸지 않고 한국어 문장과 정확한 원문 범위를 연결합니다. 불확실한 대응은 확인이 필요하다고 표시합니다.",
      timing: "두 번째 요청 · 번역 저장 후",
    },
  } satisfies Record<keyof typeof BUNDLED_SKILLS, { title: string; description: string; timing: string }>;

  must("#skillList").innerHTML = Object.entries(BUNDLED_SKILLS).map(([id, content]) => {
    const meta = descriptions[id as keyof typeof descriptions];
    const version = content.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? "—";
    return `<article class="skill-card" aria-labelledby="skill-${esc(id)}">
      <div class="skill-card-head"><div><p class="skill-timing">${esc(meta.timing)}</p><h2 id="skill-${esc(id)}">${esc(meta.title)}</h2></div><span class="tag tag-line mono">v${esc(version)}</span></div>
      <p class="skill-description">${esc(meta.description)}</p>
      <p class="skill-name mono">${esc(id)}</p>
      <details class="skill-details"><summary>SKILL.md 전체 내용</summary><pre class="skill-source" tabindex="0" aria-label="${esc(meta.title)} 스킬 원문"><code>${esc(content)}</code></pre></details>
    </article>`;
  }).join("");
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
  const pages: Record<SectionId, string> = { account: "#settingsAccount", models: "#settingsModels", skills: "#settingsSkills", general: "#settingsGeneral" };
  for (const [id, selector] of Object.entries(pages)) {
    const page = must(selector);
    page.classList.toggle("is-open", section === id);
    page.hidden = section !== id;
  }
  history.replaceState(null, "", section === "models" ? "settings.html" : `settings.html#${section}`);
  must("#saveState").hidden = section === "account";
  must("#settingsPath").textContent = section === "account" ? "문해 계정" : "앱 설정 · 프로젝트 밖에 저장";
}

function sectionFromHash(): SectionId {
  return location.hash === "#account" ? "account" : location.hash === "#skills" ? "skills" : location.hash === "#general" ? "general" : "models";
}

window.addEventListener("hashchange", () => setSection(sectionFromHash()));

async function rescanAgents(showFailure = true): Promise<void> {
  if (agentProbePending) return;
  agentProbePending = true;
  agentProbeFailed = false;
  const button = must<HTMLButtonElement>("#btnRescan");
  button.disabled = true;
  button.textContent = "확인 중…";
  renderAgents();
  try {
    agents = await api.app.probeAgents();
    hasFreshAgentProbes = true;
  } catch (error) {
    agentProbeFailed = true;
    if (showFailure) notify(error instanceof Error ? error.message : "CLI 상태를 확인하지 못했습니다.", "로컬 CLI");
  } finally {
    agentProbePending = false;
    button.disabled = false;
    button.textContent = "다시 확인";
    renderAgents();
  }
}

async function showLoginInstruction(agentId: AgentId, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  button.textContent = "확인 중…";
  try {
    const instruction = await api.app.getLoginInstruction(agentId);
    loginInstructions.set(agentId, {
      command: instruction.displayCommand,
      detail: instruction.available
        ? "이 명령을 터미널에서 실행해 CLI 로그인을 완료하세요."
        : `${instruction.detail} CLI를 설치한 뒤 이 명령을 실행하세요.`,
    });
    renderAgents();
  } catch (error) {
    notify(error instanceof Error ? error.message : "로그인 안내를 불러오지 못했습니다.", agentName(agentId));
  } finally {
    button.disabled = false;
    button.textContent = "로그인 안내";
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
  }
});

must("#cliList").addEventListener("change", (event) => {
  if (!config) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target instanceof HTMLInputElement && target.name === "defaultAgent") {
    config.agentId = target.value as AgentId;
    renderAgents();
    scheduleSave();
    return;
  }
  const modelAgent = target.dataset.agentModel as AgentId | undefined;
  if (modelAgent) {
    config.agentModels[modelAgent].model = target.value || "default";
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
    document.querySelector(".titlebar .tb-c small")!.textContent = `${project.title} · 앱 전체`;
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
    undefined,
    tree,
  );
  renderAgents();
  setSaveState("저장됨", "saved");
}

renderSkills();
setSection(sectionFromHash());
await load();
