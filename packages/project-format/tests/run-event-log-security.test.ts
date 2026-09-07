import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendRunEventLine,
  closeRunEventLog,
  openRunEventLog,
} from "../../../apps/desktop/src/main/run-event-log.ts";
import { createPackageDir } from "../src/index.ts";

const dirs: string[] = [];

function setupPackage(): { parent: string; packagePath: string } {
  const parent = mkdtempSync(join(tmpdir(), "munhae-event-log-"));
  dirs.push(parent);
  const { packagePath } = createPackageDir({
    parentDir: parent,
    title: "event-log",
    projectId: "01900000-0000-7000-8000-000000000015",
    createdAt: "2026-09-04T00:00:00.000Z",
  });
  return { parent, packagePath };
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("AI run event log package boundary", () => {
  it.skipIf(process.platform === "win32")("keeps writes on the opened file after the pathname is replaced by a symlink", () => {
    const { parent, packagePath } = setupPackage();
    const log = openRunEventLog(packagePath, "01900000-0000-7000-8000-000000000015");
    appendRunEventLine(log, "first\n");
    expect(statSync(log.filePath).mode & 0o777).toBe(0o600);

    const openedFile = `${log.filePath}.opened`;
    const outsideFile = join(parent, "outside-events.jsonl");
    writeFileSync(outsideFile, "outside\n", "utf8");
    renameSync(log.filePath, openedFile);
    symlinkSync(outsideFile, log.filePath);

    appendRunEventLine(log, "second\n");
    closeRunEventLog(log);
    expect(readFileSync(openedFile, "utf8")).toBe("first\nsecond\n");
    expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
    expect(() => appendRunEventLine(log, "late\n")).toThrow(/closed/);
  });

  it.skipIf(process.platform === "win32")("refuses an existing symlink at the final event-file component", () => {
    const { parent, packagePath } = setupPackage();
    const messageId = "01900000-0000-7000-8000-000000000016";
    const eventFile = join(packagePath, "runs", messageId, "events.jsonl");
    mkdirSync(dirname(eventFile), { recursive: true });
    const outsideFile = join(parent, "outside-final.jsonl");
    writeFileSync(outsideFile, "outside\n", "utf8");
    symlinkSync(outsideFile, eventFile);

    expect(() => openRunEventLog(packagePath, messageId)).toThrow(/symbolic links/);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  });
});
