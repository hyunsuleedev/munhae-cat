import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTranslationSkill } from "@munhae/db-sqlite";
import type { InstalledPlugin } from "../shared/munhae-api";
import { parsePluginName } from "./ipc-validate";
import { log } from "./log";

/** Each plugin is `<root>/<name>/SKILL.md`; the folder name must match the frontmatter name. */
export function listInstalledPlugins(root: string): InstalledPlugin[] {
  if (!existsSync(root)) return [];
  const plugins: InstalledPlugin[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, "SKILL.md");
    try {
      const skill = parseTranslationSkill(readFileSync(file, "utf8"));
      if (skill.name !== entry.name) throw new Error("name mismatch");
      plugins.push({ ...skill, installedAt: statSync(file).mtime.toISOString() });
    } catch (error) {
      log.warn("skipped invalid plugin", { name: entry.name, reason: error instanceof Error ? error.message : "unknown" });
    }
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

/** Installing a plugin with an existing name replaces it (an update). */
export function installPlugin(root: string, content: string): InstalledPlugin {
  const skill = parseTranslationSkill(content);
  const dir = join(root, skill.name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, skill.content, "utf8");
  renameSync(temp, file);
  return { ...skill, installedAt: statSync(file).mtime.toISOString() };
}

export function removePlugin(root: string, name: string): void {
  rmSync(join(root, parsePluginName(name)), { recursive: true, force: true });
}
