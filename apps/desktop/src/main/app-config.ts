import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_APP_CONFIG, type AppConfig } from "../shared/munhae-api";
import { AppError } from "./errors";
import { log } from "./log";

const SECRET_KEY = /token|apikey|authorization|cookie|password|secret|bearer/i;

function configPath(userDataDir: string): string {
  return join(userDataDir, "app-config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripSecrets(nested);
  }
  return out;
}

function parseAgentId(value: unknown): AppConfig["agentId"] | undefined {
  return value === "codex" || value === "claude" || value === "antigravity" ? value : undefined;
}

function parseModelPrefs(value: unknown): AppConfig["agentModels"][keyof AppConfig["agentModels"]] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.model !== "string") return undefined;
  const model = value.model.trim();
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) return undefined;
  const reasoning = value.reasoning === null
    || value.reasoning === "low"
    || value.reasoning === "medium"
    || value.reasoning === "high"
    || value.reasoning === "xhigh"
    || value.reasoning === "max"
    ? value.reasoning
    : null;
  const serviceTier = value.serviceTier === null
    || value.serviceTier === "auto"
    || value.serviceTier === "default"
    || value.serviceTier === "flex"
    || value.serviceTier === "priority"
    ? value.serviceTier
    : null;
  return { model, reasoning, serviceTier };
}

export function parseAppConfig(value: unknown): AppConfig {
  const cleaned = stripSecrets(value);
  const rec = isRecord(cleaned) ? cleaned : {};
  const agentId = parseAgentId(rec.agentId) ?? DEFAULT_APP_CONFIG.agentId;
  const models = isRecord(rec.agentModels) ? rec.agentModels : {};
  const codex = parseModelPrefs(models.codex) ?? DEFAULT_APP_CONFIG.agentModels.codex;
  const parsedClaude = parseModelPrefs(models.claude) ?? DEFAULT_APP_CONFIG.agentModels.claude;
  // The current Claude CLI adapter has no service-tier flag. Keep the stored
  // request preference honest rather than recording an option never sent.
  const claude = { ...parsedClaude, serviceTier: null };
  const parsedAntigravity = parseModelPrefs(models.antigravity) ?? DEFAULT_APP_CONFIG.agentModels.antigravity;
  const antigravity = { ...parsedAntigravity, serviceTier: null,
    reasoning: ["low", "medium", "high"].includes(parsedAntigravity.reasoning ?? "") ? parsedAntigravity.reasoning : null };
  const showWelcomeOnLaunch =
    typeof rec.showWelcomeOnLaunch === "boolean"
      ? rec.showWelcomeOnLaunch
      : DEFAULT_APP_CONFIG.showWelcomeOnLaunch;
  return {
    agentId,
    agentModels: { codex, claude, antigravity },
    showWelcomeOnLaunch,
    backgroundMusicVolume: typeof rec.backgroundMusicVolume === "number" && Number.isFinite(rec.backgroundMusicVolume)
      ? Math.round(Math.min(100, Math.max(0, rec.backgroundMusicVolume)))
      : DEFAULT_APP_CONFIG.backgroundMusicVolume,
    notificationSoundEnabled: typeof rec.notificationSoundEnabled === "boolean" ? rec.notificationSoundEnabled : true,
    notificationSoundVolume: typeof rec.notificationSoundVolume === "number" && Number.isFinite(rec.notificationSoundVolume)
      ? Math.round(Math.min(100, Math.max(0, rec.notificationSoundVolume))) : 35,
    backgroundMusicEnabled: typeof rec.backgroundMusicEnabled === "boolean" ? rec.backgroundMusicEnabled : true,
  };
}

export function parseConfigPatch(value: unknown): Partial<AppConfig> {
  if (!isRecord(value)) {
    throw new AppError("invalid_payload", "설정 값이 올바르지 않습니다.");
  }
  for (const key of Object.keys(value)) {
    if (SECRET_KEY.test(key)) {
      throw new AppError("invalid_payload", "설정에 비밀 값을 저장할 수 없습니다.");
    }
  }
  const allowed = new Set(["agentId", "agentModels", "showWelcomeOnLaunch", "backgroundMusicEnabled", "backgroundMusicVolume", "notificationSoundEnabled", "notificationSoundVolume"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AppError("invalid_payload", "알 수 없는 설정 항목입니다.");
    }
  }
  const parsed = parseAppConfig({ ...DEFAULT_APP_CONFIG, ...value });
  const patch: Partial<AppConfig> = {};
  if ("agentId" in value) patch.agentId = parsed.agentId;
  if ("agentModels" in value) patch.agentModels = parsed.agentModels;
  if ("showWelcomeOnLaunch" in value) patch.showWelcomeOnLaunch = parsed.showWelcomeOnLaunch;
  if ("backgroundMusicEnabled" in value) patch.backgroundMusicEnabled = parsed.backgroundMusicEnabled;
  if ("backgroundMusicVolume" in value) patch.backgroundMusicVolume = parsed.backgroundMusicVolume;
  if ("notificationSoundEnabled" in value) patch.notificationSoundEnabled = parsed.notificationSoundEnabled;
  if ("notificationSoundVolume" in value) patch.notificationSoundVolume = parsed.notificationSoundVolume;
  return patch;
}

export function loadAppConfig(userDataDir: string): AppConfig {
  const file = configPath(userDataDir);
  if (!existsSync(file)) {
    saveAppConfig(userDataDir, DEFAULT_APP_CONFIG);
    return { ...DEFAULT_APP_CONFIG, agentModels: { ...DEFAULT_APP_CONFIG.agentModels } };
  }
  try {
    const raw = readFileSync(file, "utf8");
    return parseAppConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    log.warn("app-config.json unreadable; using defaults");
    return parseAppConfig(DEFAULT_APP_CONFIG);
  }
}

export function saveAppConfig(userDataDir: string, config: AppConfig): void {
  const file = configPath(userDataDir);
  mkdirSync(dirname(file), { recursive: true });
  const payload = JSON.stringify(stripSecrets(config), null, 2);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

export function mergeAppConfig(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return parseAppConfig({
    ...current,
    ...patch,
    agentModels: {
      ...current.agentModels,
      ...(patch.agentModels ?? {}),
    },
  });
}
