import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretStorageEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
  getSelectedStorageBackend?(): string;
}

/** Supabase sessions belong to this device, never to a portable project. */
export class AccountStorage {
  private values: Record<string, string> = {};
  readonly persistent: boolean;

  constructor(private readonly path: string, private readonly encryption: SecretStorageEncryption) {
    this.persistent = encryption.isEncryptionAvailable()
      && encryption.getSelectedStorageBackend?.() !== "basic_text";
    if (!this.persistent) return;
    try {
      const parsed: unknown = JSON.parse(encryption.decryptString(readFileSync(path)));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") this.values[key] = value;
        }
      }
    } catch {
      // Missing, corrupted, or another OS user's session: start signed out.
    }
  }

  getItem(key: string): string | null { return this.values[key] ?? null; }

  setItem(key: string, value: string): void {
    this.commit({ ...this.values, [key]: value });
  }

  removeItem(key: string): void {
    const next = { ...this.values };
    delete next[key];
    this.commit(next);
  }

  private commit(next: Record<string, string>): void {
    if (this.persistent) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      try {
        writeFileSync(tmp, this.encryption.encryptString(JSON.stringify(next)), { mode: 0o600 });
        renameSync(tmp, this.path);
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* No plaintext fallback. */ }
        throw error;
      }
    }
    this.values = next;
  }
}
