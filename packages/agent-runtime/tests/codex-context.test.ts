import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexDisabledSkillPaths, codexContextArgs } from "../src/codex-context";
import { buildCodexArgs } from "../src/index";
it("discovers local and symlinked skills without reading bodies or following cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "munhae-skill-test-"));
  try {
    await mkdir(join(root, "skills/a"), { recursive: true });
    await writeFile(join(root, "skills/a/SKILL.md"), "private body");
    await symlink(join(root, "skills/a"), join(root, "skills/alias"));
    await symlink(join(root, "skills"), join(root, "skills/a/loop"));
    const paths = await codexDisabledSkillPaths([join(root, "skills"), join(root, "missing")]);
    expect(paths).toEqual(expect.arrayContaining([join(root, "skills/a/SKILL.md"), join(root, "skills/alias/SKILL.md")]));
    expect(paths.every(p => p.endsWith("SKILL.md") && !p.includes("loop"))).toBe(true);
    const args = buildCodexArgs({ cwd: "/tmp/task", disabledUserSkillPaths: paths });
    expect(args).toEqual(expect.arrayContaining(codexContextArgs(paths)));
    expect(args.join(" ")).not.toContain("private body");
    expect(buildCodexArgs({ cwd: "/tmp/task" }).join(" ")).not.toContain("memories.use_memories");
  } finally { await rm(root, { recursive: true, force: true }); }
});
