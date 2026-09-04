import { probeAll } from "@munhae/agent-runtime";
import type { AgentProbe } from "../shared/munhae-api";
import { log } from "./log";

const TTL_MS = 15_000;

let cache: { at: number; probes: AgentProbe[] } | null = null;

export async function probeAgentsCached(): Promise<AgentProbe[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.probes;
  const probes = (await probeAll()) as AgentProbe[];
  cache = { at: now, probes };
  log.info("agent probe", {
    agents: probes.map((probe) => ({
      agentId: probe.agentId,
      installed: probe.installed,
      loggedIn: probe.loggedIn,
    })),
  });
  return probes;
}

export function invalidateAgentProbeCache(): void {
  cache = null;
}
