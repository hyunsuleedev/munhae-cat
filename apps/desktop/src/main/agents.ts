import type { AgentProbe } from "../shared/munhae-api";
import { probeAllAgentRuntimes } from "./agent-runtime-client";
import { log } from "./log";

const TTL_MS = 15_000;

let cache: { at: number; probes: AgentProbe[] } | null = null;

let inFlight: Promise<AgentProbe[]> | null = null;
let generation = 0;

/** Last known status is sufficient for navigation; refresh separately. */
export function getCachedAgentProbes(): AgentProbe[] {
  return cache?.probes ?? [];
}

export function probeAgentsCached(): Promise<AgentProbe[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.probes);
  if (inFlight) return inFlight;
  const startedGeneration = generation;
  const request = probeAllAgentRuntimes().then((probes) => {
    if (generation === startedGeneration) cache = { at: Date.now(), probes };
    log.info("agent probe", {
      agents: probes.map(({ agentId, installed, loggedIn }) => ({ agentId, installed, loggedIn })),
    });
    return probes;
  }).finally(() => {
    if (inFlight === request) inFlight = null;
  });
  inFlight = request;
  return request;
}

export function invalidateAgentProbeCache(): void {
  cache = null;
  generation += 1;
  inFlight = null;
}
