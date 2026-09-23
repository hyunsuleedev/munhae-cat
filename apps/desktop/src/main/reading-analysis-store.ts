import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "./errors";
import { isInsidePackageRoot } from "./paths";

export const READING_RUN_LIMIT = 24;
export const isReadingRunId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const failed = (): never => { throw new AppError("reading_storage_failed", "구절 분석 기록을 읽거나 저장하지 못했습니다."); };

/** An explicit bounded index avoids scanning arbitrary files in an imported project. */
export class ReadingAnalysisStore {
  private readonly directory: string;
  private readonly packagePath: string;
  constructor(packagePath: string) {
    this.packagePath = realpathSync(packagePath);
    this.directory = join(this.packagePath, "runs", "reading-study");
  }
  private path(name: string): string {
    const path = join(this.directory, name);
    // Check existing ancestors too: realpath on a not-yet-created child does not
    // detect a `runs` symlink in an imported package.
    for (const directory of [join(this.packagePath, "runs"), this.directory]) {
      try { if (!lstatSync(directory).isDirectory()) return failed(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failed(); }
    }
    if (!isInsidePackageRoot(this.packagePath, this.directory) || !isInsidePackageRoot(this.packagePath, path)) return failed();
    return path;
  }
  private read(name: string, limit: number): unknown | null {
    const path = this.path(name);
    let fd: number | undefined;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > limit) return failed();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const bytes = readFileSync(fd);
      if (bytes.length > limit) return failed();
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return failed();
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  ids(): string[] {
    const data = this.read("index.json", 16_384);
    if (data === null) return [];
    if (!Array.isArray(data) || data.length > READING_RUN_LIMIT || data.some(id => !isReadingRunId(id)) || new Set(data).size !== data.length) return failed();
    return data as string[];
  }
  load(id: string): unknown | null {
    if (!isReadingRunId(id) || !this.ids().includes(id)) return null;
    return this.read(`${id}.json`, MAX_RECORD_BYTES);
  }
  private atomic(name: string, value: unknown, limit: number): void {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > limit) return failed();
    const path = this.path(name);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.path(`.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, body, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
    } catch { return failed(); }
    finally { if (fd !== undefined) closeSync(fd); rmSync(temporary, { force: true }); }
  }
  save(id: string, value: unknown): void {
    if (!isReadingRunId(id)) return failed();
    const old = this.ids();
    this.atomic(`${id}.json`, value, MAX_RECORD_BYTES);
    // Updating a past record must not make it the most recent requested analysis.
    const next = old.includes(id) ? old : [id, ...old];
    this.atomic("index.json", next.slice(0, READING_RUN_LIMIT), 16_384);
    for (const removed of next.slice(READING_RUN_LIMIT)) rmSync(this.path(`${removed}.json`), { force: true });
  }
}
