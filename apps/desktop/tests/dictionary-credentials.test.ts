import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SecretStorageEncryption } from "../src/main/auth-storage";

vi.mock("electron", () => ({ app: { getPath: vi.fn() }, safeStorage: {} }));
import { DictionaryCredentialStore } from "../src/main/dictionary-credentials";

const paths: string[] = [];
const KEY_A = "a1".repeat(16);
const KEY_B = "b2".repeat(16);
function fixture(overrides: Partial<SecretStorageEncryption> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "munhae-dict-credentials-"));
  paths.push(folder);
  const path = join(folder, "dictionary-keys.enc");
  const secret = randomBytes(32);
  const encryption: SecretStorageEncryption = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },
    decryptString(value) {
      const decipher = createDecipheriv("aes-256-gcm", secret, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
    },
    ...overrides,
  };
  return { folder, path, encryption, store: new DictionaryCredentialStore(path, encryption) };
}
afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("device dictionary credentials", () => {
  it("encrypts, limits permissions, reopens both keys and exposes only flags", () => {
    const { store, path, folder, encryption } = fixture();
    expect(store.status()).toEqual({ opendict: false, stdict: false });
    expect(store.set({ provider: "opendict", apiKey: ` ${KEY_A} ` })).toEqual({ opendict: true, stdict: false });
    expect(store.set({ provider: "stdict", apiKey: KEY_B })).toEqual({ opendict: true, stdict: true });
    const disk = readFileSync(path);
    expect(disk.includes(KEY_A)).toBe(false);
    expect(disk.includes(KEY_B)).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(["dictionary-keys.enc"]);
    const reopened = new DictionaryCredentialStore(path, encryption);
    expect(reopened.get("opendict")).toBe(KEY_A);
    expect(reopened.get("stdict")).toBe(KEY_B);
    expect(JSON.stringify(reopened.status())).not.toContain(KEY_A);
    expect(reopened.set({ provider: "opendict", apiKey: "" })).toEqual({ opendict: false, stdict: true });
    expect(reopened.get("stdict")).toBe(KEY_B);
    expect(reopened.set({ provider: "stdict", apiKey: " " })).toEqual({ opendict: false, stdict: false });
    expect(readdirSync(folder)).toEqual([]);
  });

  it.each([false, "basic_text"])("never falls back to plaintext when OS protection is unavailable (%s)", (state) => {
    const { store, folder } = fixture({ isEncryptionAvailable: () => state !== false, getSelectedStorageBackend: () => String(state) });
    expect(() => store.set({ provider: "opendict", apiKey: KEY_A })).toThrow(expect.objectContaining({ code: "dictionary_key_storage_unavailable" }));
    expect(readdirSync(folder)).toEqual([]);
    expect(store.status()).toEqual({ opendict: false, stdict: false });
  });

  it("preserves the existing ciphertext and redacts failed encryption", () => {
    const { store, path, folder, encryption } = fixture();
    store.set({ provider: "opendict", apiKey: KEY_A });
    const original = readFileSync(path);
    encryption.encryptString = () => { throw new Error(`failed: ${KEY_B}`); };
    expect(() => store.set({ provider: "stdict", apiKey: KEY_B })).toThrow(expect.objectContaining({ code: "dictionary_key_storage" }));
    try { store.set({ provider: "stdict", apiKey: KEY_B }); } catch (error) { expect(String(error)).not.toContain(KEY_B); }
    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(folder)).toEqual(["dictionary-keys.enc"]);
  });

  it("distinguishes a corrupt encrypted file from a missing key without exposing its contents", () => {
    const { store, path } = fixture();
    writeFileSync(path, KEY_A);
    expect(() => store.get("opendict")).toThrow(expect.objectContaining({ code: "dictionary_key_storage" }));
    try { store.status(); } catch (error) { expect(String(error)).not.toContain(KEY_A); }
  });

  it("rejects invalid providers and key formats before writing", () => {
    const { store, folder } = fixture();
    for (const apiKey of ["x".repeat(32), "short", "a".repeat(513), `${KEY_A}\nextra`]) {
      expect(() => store.set({ provider: "opendict", apiKey })).toThrow(expect.objectContaining({ code: "dictionary_key_invalid" }));
    }
    expect(() => store.set({ provider: "__proto__", apiKey: KEY_A } as never)).toThrow();
    expect(readdirSync(folder)).toEqual([]);
  });
});
