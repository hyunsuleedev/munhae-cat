import type { AppConfig, AgentProbe } from "./munhae-api";

export function alignmentPreferences(config: AppConfig, translationAgent: AgentProbe["agentId"]) {
  return config.alignment ?? { agentId: translationAgent, ...config.agentModels[translationAgent] };
}
