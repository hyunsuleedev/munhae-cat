import { fixedGeminiEffort } from "../../shared/agent-model-preferences";
import "../styles/alignment-settings.css";
import type { AppConfig, AgentProbe } from "../../shared/munhae-api";
import { t, ui } from "./i18n";
const esc = (text: string) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const labels = { claude: "Claude CLI", codex: "Codex CLI", antigravity: "Gemini · Antigravity CLI" };
export function alignmentSettingsMarkup(config: AppConfig, probes: AgentProbe[], prefix: string): string {
  const prefs = config.alignment;
  const select = (key: string, label: string, options: Array<{ id: string; label: string }>, current: string, disabled = false) => {
    const values = [...options];
    if (!values.some(value => value.id === current)) values.push({ id: current, label: ui`${current} · 저장된 값` });
    return `<div class="field"><label for="${prefix}-${key}">${t(label)}</label><select class="select" id="${prefix}-${key}" data-alignment-setting="${key}"${disabled ? " disabled" : ""}>${values.map(value => `<option value="${esc(value.id)}"${value.id === current ? " selected" : ""}>${esc(value.label)}</option>`).join("")}</select></div>`;
  };
  const mode = select("agent", "문장 연결", [{ id: "same", label: t("번역 설정과 동일") }, ...Object.entries(labels).map(([id, label]) => ({ id, label }))], prefs?.agentId ?? "same");
  if (!prefs) return `<section class="alignment-settings">${mode}<p class="muted">${t("번역 후 자동 연결과 ‘원문 다시 연결’에 사용합니다.")}</p></section>`;
  const probe = probes.find(probe => probe.agentId === prefs.agentId);
  const model = probe?.models.find(model => model.id === prefs.model);
  const models = [{ id: "default", label: t("CLI 기본값") }, ...(probe?.models ?? []).filter(model => model.id !== "default").map(model => ({ id: model.id, label: model.label }))];
  const fixedEffort = prefs.agentId === "antigravity" ? fixedGeminiEffort(prefs.model) : null;
  const reasoning = fixedEffort ? [{ id: fixedEffort, label: fixedEffort }] : model?.reasoningOptions ?? probe?.reasoningOptions ?? [];
  return `<section class="alignment-settings">${mode}<div class="cli-controls">${select("model", "연결 모델", models, prefs.model, probe ? !probe.capabilities.modelSelection : false)}${probe?.capabilities.reasoningEffort && reasoning.length ? select("reasoning", "연결 effort", [{ id: "", label: t("CLI 기본값") }, ...reasoning], fixedEffort ?? prefs.reasoning ?? "", !!fixedEffort) : ""}</div><p class="muted">${t("번역 후 자동 연결과 ‘원문 다시 연결’에 사용합니다.")}${probe && !probe.installed ? ` ${t("해당 CLI를 먼저 설치하세요.")}` : ""}</p></section>`;
}
export function changeAlignmentSetting(config: AppConfig, probes: AgentProbe[], field: string, value: string, translationAgent = config.agentId): boolean {
  if (field === "agent") {
    if (value !== "same" && !(value in labels)) return false;
    config.alignment = value === "same" ? null : { agentId: value as AgentProbe["agentId"], ...config.agentModels[value as AgentProbe["agentId"]] };
    return true;
  }
  if (!config.alignment) return false;
  if (field === "model") {
    config.alignment.model = value;
    const fixedEffort = config.alignment.agentId === "antigravity" ? fixedGeminiEffort(value) : null;
    if (fixedEffort) { config.alignment.reasoning = fixedEffort; return true; }
    const probe = probes.find(probe => probe.agentId === config.alignment!.agentId);
    const options = probe?.models.find(model => model.id === value)?.reasoningOptions ?? probe?.reasoningOptions ?? [];
    if (!options.some(option => option.id === config.alignment!.reasoning)) config.alignment.reasoning = null;
    return true;
  }
  if (field === "reasoning") { config.alignment.reasoning = value || null; return true; }
  return false;
}
