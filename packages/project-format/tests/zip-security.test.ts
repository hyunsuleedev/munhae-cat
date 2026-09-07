import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractZip } from "../../../apps/desktop/src/main/zip.ts";

const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "munhae-zip-security-"));
  dirs.push(dir);
  return dir;
}

function signatureOffset(bytes: Buffer, signature: number): number {
  for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
    if (bytes.readUInt32LE(offset) === signature) return offset;
  }
  throw new Error(`ZIP signature ${signature.toString(16)} not found`);
}

function archive(entries: Record<string, Uint8Array>): Buffer {
  return Buffer.from(zipSync(entries, { level: 6 }));
}

async function expectRejected(bytes: Buffer): Promise<void> {
  const dir = tempDir();
  const zipPath = join(dir, "input.munhaepkg");
  const output = join(dir, "output");
  writeFileSync(zipPath, bytes);
  await expect(extractZip(zipPath, output)).rejects.toMatchObject({ code: "invalid_backup" });
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("secure ZIP extraction", () => {
  it("extracts a canonical archive", async () => {
    const dir = tempDir();
    const zipPath = join(dir, "valid.munhaepkg");
    const output = join(dir, "output");
    writeFileSync(zipPath, archive({
      "project.munhae/manifest.json": strToU8('{"format":"io.munhae.project"}\n'),
      "project.munhae/project.sqlite3": strToU8("sqlite-bytes"),
    }));

    await extractZip(zipPath, output);

    expect(readFileSync(join(output, "project.munhae/manifest.json"), "utf8"))
      .toBe('{"format":"io.munhae.project"}\n');
    expect(readFileSync(join(output, "project.munhae/project.sqlite3"), "utf8"))
      .toBe("sqlite-bytes");
  });

  it("rejects paths that collide after separator, dot-segment, Unicode, or case normalization", async () => {
    await expectRejected(archive({
      "project.munhae/text/file.txt": strToU8("first"),
      "project.munhae/text/./file.txt": strToU8("second"),
    }));

    await expectRejected(archive({
      "project.munhae/É.txt": strToU8("first"),
      "project.munhae/É.txt": strToU8("second"),
    }));

    await expectRejected(archive({
      "project.munhae/Case.txt": strToU8("first"),
      "project.munhae/case.txt": strToU8("second"),
    }));
  });

  it("rejects a local header that disagrees with the central directory", async () => {
    const bytes = archive({ "project.munhae/data.txt": strToU8("header-check") });
    const local = signatureOffset(bytes, LOCAL_SIGNATURE);
    bytes.writeUInt32LE(bytes.readUInt32LE(local + 22) + 1, local + 22);
    await expectRejected(bytes);
  });

  it("checks CRC32 after decompression even when local and central CRC fields agree", async () => {
    const bytes = archive({ "project.munhae/data.txt": strToU8("crc-check") });
    const local = signatureOffset(bytes, LOCAL_SIGNATURE);
    const central = signatureOffset(bytes, CENTRAL_SIGNATURE);
    const wrongCrc = (bytes.readUInt32LE(local + 14) ^ 0xffffffff) >>> 0;
    bytes.writeUInt32LE(wrongCrc, local + 14);
    bytes.writeUInt32LE(wrongCrc, central + 16);
    await expectRejected(bytes);
  });

  it("bounds inflate output by the declared uncompressed size", async () => {
    const bytes = archive({
      "project.munhae/bomb.txt": new Uint8Array(2 * 1024 * 1024).fill(0x41),
    });
    const local = signatureOffset(bytes, LOCAL_SIGNATURE);
    const central = signatureOffset(bytes, CENTRAL_SIGNATURE);
    bytes.writeUInt32LE(1, local + 22);
    bytes.writeUInt32LE(1, central + 24);
    await expectRejected(bytes);
  });

  it("rejects ZIP entries marked as symbolic links", async () => {
    const bytes = archive({ "project.munhae/link": strToU8("../../outside") });
    const central = signatureOffset(bytes, CENTRAL_SIGNATURE);
    bytes.writeUInt32LE((0o120777 << 16) >>> 0, central + 38);
    await expectRejected(bytes);
  });

  it("does not leave output files for a duplicate-path preflight failure", async () => {
    const dir = tempDir();
    const zipPath = join(dir, "duplicate.munhaepkg");
    const output = join(dir, "output");
    writeFileSync(zipPath, archive({
      "project.munhae/a.txt": strToU8("first"),
      "project.munhae/./a.txt": strToU8("second"),
    }));

    await expect(extractZip(zipPath, output)).rejects.toMatchObject({ code: "invalid_backup" });
    expect(existsSync(output)).toBe(false);
  });
});
