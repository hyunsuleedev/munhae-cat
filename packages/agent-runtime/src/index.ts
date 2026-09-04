import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { nowIso } from "@munhae/domain";

const execFile = promisify(execFileCb);

export type AgentId = "codex" | "claude";

export type AgentProbe = {
  agentId: AgentId;
  installed: boolean;
  loggedIn: boolean | null;
  version: string | null;
  lastCheckedAt: string;
  detail: string;
};

export interface AgentAdapter {
  probe(): Promise<AgentProbe>;
}

const PASS_ENV = new Set([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
]);

const STRIP_ENV = /AWS|GOOGLE|OPENAI|AUTHORIZATION|API_KEY|TOKEN|SECRET|PASSWORD|BEARER/i;

export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (STRIP_ENV.test(key)) continue;
    if (PASS_ENV.has(key)) out[key] = value;
  }
  return out;
}

export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-+=\/]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{8,}\b/g, "sk-[REDACTED]");
}

async function resolveBinary(name: string): Promise<string | null> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFile(cmd, [name], {
      timeout: 4000,
      env: sanitizeEnv(),
      windowsHide: true,
    });
    const line = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

function parseVersion(stdout: string): string | null {
  const redacted = redactSecrets(stdout).trim();
  if (!redacted) return null;
  const line = redacted.split(/\r?\n/).find((s) => s.trim());
  return line ? line.trim() : null;
}

async function probeLogin(bin: string, agentId: AgentId): Promise<boolean | null> {
  try {
    const { stdout, stderr } = await execFile(bin, ["auth", "status"], {
      timeout: 4000,
      env: sanitizeEnv(),
      windowsHide: true,
    });
    const combined = redactSecrets(`${stdout}\n${stderr}`).toLowerCase();
    if (combined.includes("not logged") || combined.includes("unauthenticated")) return false;
    return true;
  } catch {
    const home = homedir();
    const marker = agentId === "claude" ? join(home, ".claude") : join(home, ".codex");
    const alt = agentId === "claude" ? join(home, ".claude.json") : join(home, ".codex.json");
    if (existsSync(marker) || existsSync(alt)) return true;
    return null;
  }
}

function createAdapter(agentId: AgentId, binaryName: string): AgentAdapter {
  return {
    async probe(): Promise<AgentProbe> {
      const lastCheckedAt = nowIso();
      try {
        const bin = await resolveBinary(binaryName);
        if (!bin) {
          return {
            agentId,
            installed: false,
            loggedIn: null,
            version: null,
            lastCheckedAt,
            detail: `${binaryName} CLI not found on PATH`,
          };
        }
        let version: string | null = null;
        try {
          const { stdout } = await execFile(bin, ["--version"], {
            timeout: 4000,
            env: sanitizeEnv(),
            windowsHide: true,
          });
          version = parseVersion(stdout);
        } catch {
          version = null;
        }
        const loggedIn = await probeLogin(bin, agentId);
        return {
          agentId,
          installed: true,
          loggedIn,
          version,
          lastCheckedAt,
          detail: loggedIn === false ? "installed, login required" : "installed",
        };
      } catch (err) {
        return {
          agentId,
          installed: false,
          loggedIn: null,
          version: null,
          lastCheckedAt,
          detail: redactSecrets(err instanceof Error ? err.message : "probe failed"),
        };
      }
    },
  };
}

export function createClaudeAdapter(): AgentAdapter {
  return createAdapter("claude", "claude");
}

export function createCodexAdapter(): AgentAdapter {
  return createAdapter("codex", "codex");
}

export async function probeAll(): Promise<AgentProbe[]> {
  const [claude, codex] = await Promise.all([createClaudeAdapter().probe(), createCodexAdapter().probe()]);
  return [claude, codex];
}
