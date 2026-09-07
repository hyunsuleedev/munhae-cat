import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { uniquePath } from "../src/main/paths";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("collision paths preserve Munhae file associations", () => {
  it.each([".munhae", ".munhaepkg", ".MUNHAE"])("inserts collision counters before %s", (extension) => {
    const root = mkdtempSync(join(tmpdir(), "munhae-path-test-"));
    roots.push(root);
    const base = join(root, `서책 검증${extension}`);
    expect(uniquePath(base)).toBe(base);
    writeFileSync(base, "existing");
    writeFileSync(join(root, `서책 검증-2${extension}`), "existing second");
    expect(uniquePath(base)).toBe(join(root, `서책 검증-3${extension}`));
  });

  it.each([".munhae-import-123", "notes.txt"])("retains legacy temporary/non-package naming for %s", (name) => {
    const root = mkdtempSync(join(tmpdir(), "munhae-path-test-"));
    roots.push(root);
    const base = join(root, name);
    writeFileSync(base, "existing");
    expect(uniquePath(base)).toBe(`${base}-2`);
  });
});
