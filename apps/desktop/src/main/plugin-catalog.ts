import type { SupabaseClient } from "@supabase/supabase-js";
import { parseTranslationSkill, type TranslationSkill } from "@munhae/db-sqlite";
import { AppError } from "./errors";
import { log } from "./log";

type AuthenticatedAccess = <T>(action: (client: SupabaseClient, userId: string) => Promise<T>) => Promise<T>;

const unavailable = () => new AppError("plugin_catalog_unavailable", "추천 플러그인을 불러오지 못했습니다. 잠시 후 다시 시도하세요.");

/** Rows are curated on the server, but each one still passes the same SKILL.md checks as a local file. */
function catalogSkill(row: unknown): TranslationSkill | null {
  const { name, content } = (row ?? {}) as { name?: unknown; content?: unknown };
  try {
    const skill = parseTranslationSkill(content);
    if (skill.name === name) return skill;
  } catch { /* Reported below. */ }
  log.warn("skipped invalid catalog plugin", { name: typeof name === "string" ? name : "unknown" });
  return null;
}

export async function fetchPluginCatalog(access: AuthenticatedAccess): Promise<TranslationSkill[]> {
  const rows = await access(async (client) => {
    const { data, error } = await client.from("plugin_catalog").select("name, content")
      .eq("published", true).order("sort_order").order("name").limit(200);
    if (error || !Array.isArray(data)) throw unavailable();
    return data;
  });
  return rows.map(catalogSkill).filter((skill): skill is TranslationSkill => skill !== null);
}

export async function fetchCatalogPlugin(access: AuthenticatedAccess, name: string): Promise<TranslationSkill> {
  const row = await access(async (client) => {
    const { data, error } = await client.from("plugin_catalog").select("name, content")
      .eq("published", true).eq("name", name).maybeSingle();
    if (error) throw unavailable();
    return data;
  });
  const skill = row && catalogSkill(row);
  if (!skill) throw new AppError("not_found", "추천 목록에서 플러그인을 찾지 못했습니다.");
  return skill;
}
