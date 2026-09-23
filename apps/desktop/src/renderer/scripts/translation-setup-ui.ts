import type { AppConfig, AgentProbe, ContextPreview } from "../../shared/munhae-api";
import { fixedGeminiEffort } from "../../shared/agent-model-preferences";
import { esc } from "./shared";
import { t, ui } from "./i18n";
import "../styles/translation-setup.css";

type AgentId = AppConfig["agentId"];
type Option = { id: string; label: string };

type RequiredItem = ContextPreview["required"][number];
type PreparationContent = { text?: string; fields?: Array<{ label: string; value: string }> };

/** These describe the app/agent protocol, rather than material a translator needs to review. */
export function isTechnicalPreparationItem(item: RequiredItem): boolean {
  return item.kind === "translation_skill" || item.kind === "output_contract" || item.kind === "anchor_manifest";
}

function record(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

function languageLabel(value: string): string {
  return ({ ko: t("한국어"), en: t("영어"), lzh: t("한문") })[value] ?? value;
}

/** Presentation only: the exact request remains untouched in the transmission details. */
export function prepRequiredContent(item: RequiredItem): PreparationContent {
  const fields: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) fields.push({ label: t(label), value });
  };
  if (item.kind === "translation_policy") {
    const policy = record(item.content);
    const rules = typeof policy.rules_json === "string" ? record(policy.rules_json) : {};
    add("대상 독자", policy.audience ?? rules.audience);
    add("문체와 표현", policy.style_guide_md ?? rules.styleGuideMd);
    add("한자 표기", policy.hanja_policy ?? rules.hanjaPolicy);
    add("보충 설명", policy.supplement_policy ?? rules.supplementPolicy);
    add("불확실성 처리", policy.uncertainty_policy ?? rules.uncertaintyPolicy);
  } else if (item.kind === "document_metadata") {
    const document = record(item.content);
    add("제목", document.originalTitle || document.title);
    add("저자", document.authorName);
    add("시대", document.periodText);
    add("작성 시기", document.dateText);
    add("출전", document.sourceReference);
    if (typeof document.language === "string") add("원문 언어", languageLabel(document.language));
  } else if (item.kind === "target_language") {
    return { text: item.version ? languageLabel(item.version) : item.content };
  } else if (item.kind === "review_comments" || item.kind === "reference_comments") {
    const start = item.kind === "reference_comments" ? item.content.indexOf("\n[") + 1 : 0;
    try {
      const comments: unknown = JSON.parse(item.content.slice(start));
      if (Array.isArray(comments)) {
        for (const comment of comments) {
          if (!comment || typeof comment !== "object") continue;
          add(comment.targetKind === "source" ? "원문 구절" : "번역 구절", comment.quote);
          add("검토 의견", comment.bodyMd);
        }
      }
    } catch { /* The unmodified input remains available under transmission details. */ }
    if (fields.length) return { fields, text: start ? item.content.slice(0, start).trim() : undefined };
  } else {
    return { text: item.content };
  }
  return fields.length ? { fields } : { text: t("내용은 전송 상세에서 확인할 수 있습니다.") };
}

export function prepModelOptions(config: AppConfig, probe: AgentProbe | undefined, agent: AgentId) {
  const prefs = config.agentModels[agent];
  const model = probe?.models.find(item => item.id === prefs.model);
  const fixed = agent === "antigravity" ? fixedGeminiEffort(prefs.model) : null;
  return {
    fixed,
    models: [{ id: "default", label: t("CLI 기본값") }, ...(probe?.models ?? []).filter(item => item.id !== "default")],
    reasoning: fixed ? [{ id: fixed, label: fixed }] : model?.reasoningOptions ?? probe?.reasoningOptions ?? [],
    tiers: model?.serviceTierOptions ?? probe?.serviceTierOptions ?? [],
  };
}

function field(key: string, label: string, options: Option[], current: string, disabled: boolean): string {
  const all = [...options];
  if (!all.some(option => option.id === current)) all.push({ id: current, label: ui`${current} · 저장된 값` });
  return `<div class="field"><label for="prep-model-${key}">${esc(t(label))}</label><select class="select" id="prep-model-${key}" data-prep-model-setting="${key}" data-capability-disabled="${disabled}"${disabled ? " disabled" : ""}>${all.map(option => `<option value="${esc(option.id)}"${option.id === current ? " selected" : ""}>${esc(option.label)}</option>`).join("")}</select></div>`;
}

export function prepModelMarkup(config: AppConfig, probe: AgentProbe | undefined, agent: AgentId): string {
  const prefs = config.agentModels[agent];
  const { models, reasoning, tiers, fixed } = prepModelOptions(config, probe, agent);
  const unavailable = !probe?.installed;
  return field("model", "모델", models, prefs.model, unavailable || !probe?.capabilities.modelSelection)
    + (probe?.capabilities.reasoningEffort ? field("reasoning", "추론 수준", [{ id: "", label: t("CLI 기본값") }, ...reasoning], fixed ?? prefs.reasoning ?? "", unavailable || !!fixed) : "")
    + (probe?.capabilities.serviceTier ? field("serviceTier", "서비스 등급", [{ id: "", label: t("CLI 기본값") }, ...tiers], prefs.serviceTier ?? "", unavailable) : "");
}

/** Preserve other providers and clear options that the newly selected model cannot use. */
export function changePrepModelSetting(config: AppConfig, probe: AgentProbe | undefined, agent: AgentId, key: string, value: string): boolean {
  if (!probe?.installed) return false;
  const prefs = config.agentModels[agent];
  const options = prepModelOptions(config, probe, agent);
  if (key === "model") {
    if (!probe.capabilities.modelSelection || !options.models.some(model => model.id === value)) return false;
    prefs.model = value;
    const next = prepModelOptions(config, probe, agent);
    if (next.fixed) prefs.reasoning = next.fixed;
    else if (!next.reasoning.some(option => option.id === prefs.reasoning)) prefs.reasoning = null;
    if (!next.tiers.some(option => option.id === prefs.serviceTier)) prefs.serviceTier = null;
    return true;
  }
  if (key === "reasoning") {
    if (options.fixed || !probe.capabilities.reasoningEffort || (value && !options.reasoning.some(option => option.id === value))) return false;
    prefs.reasoning = value || null;
    return true;
  }
  if (key === "serviceTier") {
    if (!probe.capabilities.serviceTier || (value && !options.tiers.some(option => option.id === value))) return false;
    prefs.serviceTier = value || null;
    return true;
  }
  return false;
}

export function prepAlignmentSummary(config: AppConfig, probes: AgentProbe[]): string {
  if (!config.alignment) return t("번역 설정과 동일");
  const prefs = config.alignment;
  const agent = prefs.agentId === "antigravity" ? "Gemini" : prefs.agentId === "codex" ? "Codex" : "Claude";
  const model = probes.find(probe => probe.agentId === prefs.agentId)?.models.find(model => model.id === prefs.model)?.label;
  return [agent, prefs.model === "default" ? t("CLI 기본값") : model ?? prefs.model, prefs.reasoning].filter(Boolean).join(" · ");
}
