import { describe, expect, it } from "vitest";
import { probeAll, redactSecrets, sanitizeEnv } from "../src/index.ts";

describe("probeAll", () => {
  it("does not throw if binaries are missing", async () => {
    const probes = await probeAll();
    expect(probes).toHaveLength(2);
    expect(probes.map((p) => p.agentId).sort()).toEqual(["claude", "codex"]);
    for (const p of probes) {
      expect(typeof p.installed).toBe("boolean");
      expect(typeof p.lastCheckedAt).toBe("string");
      expect(typeof p.detail).toBe("string");
      expect(p.detail).not.toMatch(/Bearer\s+\S/i);
      expect(p.detail).not.toMatch(/\bsk-[A-Za-z0-9]{8,}\b/);
    }
  });
});

describe("redactSecrets", () => {
  it("masks Bearer and sk- patterns", () => {
    expect(redactSecrets("Authorization: Bearer abc.def-ghi")).toContain("[REDACTED]");
    expect(redactSecrets("key sk-abcdefghijklmnopqrstuvwxyz")).toContain("sk-[REDACTED]");
  });
});

describe("sanitizeEnv", () => {
  it("keeps PATH/HOME and strips provider keys", () => {
    const env = sanitizeEnv({
      PATH: "/usr/bin",
      HOME: "/tmp",
      OPENAI_API_KEY: "sk-secret",
      AWS_SECRET_ACCESS_KEY: "x",
      AUTHORIZATION: "Bearer tok",
      LANG: "en_US.UTF-8",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/tmp");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AUTHORIZATION).toBeUndefined();
  });
});
