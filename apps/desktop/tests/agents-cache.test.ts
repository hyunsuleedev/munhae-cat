import { beforeEach, expect, it, vi } from "vitest";
const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../src/main/agent-runtime-client", () => ({ probeAllAgentRuntimes: probe }));
vi.mock("../src/main/log", () => ({ log: { info: vi.fn() } }));
import { getCachedAgentProbes, invalidateAgentProbeCache, probeAgentsCached } from "../src/main/agents";
const probes = [{ agentId: "codex", installed: true, loggedIn: true }];
beforeEach(() => { invalidateAgentProbeCache(); probe.mockReset(); });
it("returns navigation status immediately while concurrent probes share one request", async () => {
  let resolve!: (value: typeof probes) => void;
  probe.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const first = probeAgentsCached();
  const second = probeAgentsCached();
  expect(getCachedAgentProbes()).toEqual([]);
  expect(probe).toHaveBeenCalledTimes(1);
  resolve(probes);
  expect(await first).toEqual(probes);
  expect(await second).toEqual(probes);
  expect(getCachedAgentProbes()).toEqual(probes);
  await probeAgentsCached();
  expect(probe).toHaveBeenCalledTimes(1);
});
it("allows retry after failure", async () => {
  probe.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(probes);
  await expect(probeAgentsCached()).rejects.toThrow("offline");
  expect(await probeAgentsCached()).toEqual(probes);
});
it("does not restore invalidated status when an older request completes", async () => {
  let resolve!: (value: typeof probes) => void;
  probe.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const old = probeAgentsCached();
  invalidateAgentProbeCache();
  resolve(probes);
  await old;
  expect(getCachedAgentProbes()).toEqual([]);
});
