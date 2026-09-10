import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { initFileLogging, log } from "../src/main/log";
it("persists startup diagnostics with secret redaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "munhae-log-"));
  const output = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    initFileLogging(directory);
    log.error("update failed", new Error("failed to load native module sk-testcredential123456"));
    const text = readFileSync(join(directory, "main.log"), "utf8");
    expect(text).toContain("update failed");
    expect(text).toContain("failed to load native module");
    expect(text).not.toContain("sk-testcredential123456");
  } finally { output.mockRestore(); rmSync(directory, { recursive: true, force: true }); }
});
