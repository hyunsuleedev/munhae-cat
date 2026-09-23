import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Discover files, not skill bodies. Codex 0.155 matches disabled SKILL.md paths. */
export async function codexDisabledSkillPaths(roots: string[]): Promise<string[]> {
  const paths = new Set<string>();
  async function visit(path: string, ancestors: Set<string>, depth: number): Promise<void> {
    if (depth > 16) throw new Error("Skill directory nesting exceeds the isolation scan limit");
    let canonical: string;
    try { canonical = await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (ancestors.has(canonical)) return;
    const entries = await readdir(path, { withFileTypes: true });
    if (entries.some(e => e.name === "SKILL.md" && (e.isFile() || e.isSymbolicLink()))) {
      paths.add(join(path, "SKILL.md"));
      paths.add(await realpath(join(path, "SKILL.md")));
    }
    const next = new Set(ancestors).add(canonical);
    for (const entry of entries) {
      if (entry.name === "SKILL.md") continue;
      if (entry.isDirectory()) await visit(join(path, entry.name), next, depth + 1);
      else if (entry.isSymbolicLink()) {
        try { await visit(join(path, entry.name), next, depth + 1); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error; }
      }
    }
  }
  for (const root of roots) await visit(root, new Set(), 0);
  return [...paths].sort();
}

export function codexContextArgs(disabledSkills: readonly string[]): string[] {
  return [
    "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false",
    "--disable", "plugins", "--disable", "multi_agent",
    "-c", "project_doc_max_bytes=0", "-c", 'developer_instructions=""',
    "-c", `skills.config=[${disabledSkills.map(path => `{path=${JSON.stringify(path)},enabled=false}`).join(",")}]`,
  ];
}
