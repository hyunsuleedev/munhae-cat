import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { resolvePackagePath } from "@munhae/project-format";

export type RunEventLog = {
  filePath: string;
  fd: number | null;
};

/**
 * Creates one append-only event log and keeps its descriptor open for the run.
 * Later path replacement cannot redirect writes through a symbolic link.
 */
export function openRunEventLog(packagePath: string, messageId: string): RunEventLog {
  const relativePath = `runs/${messageId}/events.jsonl`;
  const eventFile = resolvePackagePath(packagePath, relativePath);
  mkdirSync(dirname(eventFile), { recursive: true });
  const validatedEventFile = resolvePackagePath(packagePath, relativePath);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(
    validatedEventFile,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | noFollow,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile()) throw new Error("AI run event log is not a regular file");
    return { filePath: validatedEventFile, fd };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function appendRunEventLine(log: RunEventLog, line: string): void {
  if (log.fd === null) throw new Error("AI run event log is closed");
  writeSync(log.fd, line, null, "utf8");
}

export function syncRunEventLog(log: RunEventLog): void {
  if (log.fd !== null) fsyncSync(log.fd);
}

export function closeRunEventLog(log: RunEventLog): void {
  if (log.fd === null) return;
  const fd = log.fd;
  log.fd = null;
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
