import { app, safeStorage } from "electron";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { DictionaryKeyProvider, DictionarySetKeyInput } from "../shared/dictionary-types";
import type { SecretStorageEncryption } from "./auth-storage";
import { AppError } from "./errors";

type Keys = Partial<Record<DictionaryKeyProvider, string>>;
type KeyStatus = Record<DictionaryKeyProvider, boolean>;
const validKey = /^[a-f\d]{32}$/i;

function provider(value: unknown): DictionaryKeyProvider {
  if (value !== "opendict" && value !== "stdict") {
    throw new AppError("invalid_input", "지원하지 않는 사전 인증 키입니다.");
  }
  return value;
}

/** Device-only encrypted storage. No secrets are returned by status or set. */
export class DictionaryCredentialStore {
  constructor(private readonly path: string, private readonly encryption: SecretStorageEncryption) {}

  private available(): boolean {
    try {
      return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== "basic_text";
    } catch { return false; }
  }

  private read(): Keys {
    try {
      const info = statSync(this.path);
      if (!info.isFile() || info.size > 16_384) throw new Error("Invalid credential file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new AppError("dictionary_key_storage", "사전 인증 키 저장소를 읽을 수 없습니다.");
    }
    if (!this.available()) {
      throw new AppError("dictionary_key_storage_unavailable", "운영체제의 안전한 인증 키 저장소를 사용할 수 없습니다.");
    }
    try {
      const value: unknown = JSON.parse(this.encryption.decryptString(readFileSync(this.path)));
      if (typeof value !== "object" || !value || !("version" in value) || value.version !== 1
        || !("keys" in value) || typeof value.keys !== "object" || !value.keys || Array.isArray(value.keys)) throw new Error();
      const keys: Keys = {};
      for (const [name, key] of Object.entries(value.keys)) {
        if ((name !== "opendict" && name !== "stdict") || typeof key !== "string" || !validKey.test(key)) throw new Error();
        keys[name] = key;
      }
      return keys;
    } catch {
      throw new AppError("dictionary_key_storage", "저장된 사전 인증 키를 해독할 수 없습니다. 운영체제의 키 저장소를 확인하세요.");
    }
  }

  get(keyProvider: DictionaryKeyProvider): string | null {
    return this.read()[provider(keyProvider)] ?? null;
  }

  status(): KeyStatus {
    const keys = this.read();
    return { opendict: Boolean(keys.opendict), stdict: Boolean(keys.stdict) };
  }

  set(input: DictionarySetKeyInput): KeyStatus {
    if (!input || typeof input !== "object" || typeof input.apiKey !== "string") {
      throw new AppError("invalid_input", "사전 인증 키를 확인하세요.");
    }
    const name = provider(input.provider);
    const key = input.apiKey.trim();
    if (key && !validKey.test(key)) {
      throw new AppError("dictionary_key_invalid", "인증 키는 발급받은 32자리 영문·숫자(16진수)로 입력하세요.");
    }
    const next = this.read();
    if (key) next[name] = key;
    else delete next[name];
    const status = { opendict: Boolean(next.opendict), stdict: Boolean(next.stdict) };
    if (!Object.keys(next).length) {
      try { unlinkSync(this.path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AppError("dictionary_key_storage", "사전 인증 키를 삭제할 수 없습니다.");
        }
      }
      return status;
    }
    if (!this.available()) {
      throw new AppError("dictionary_key_storage_unavailable", "운영체제의 안전한 인증 키 저장소를 사용할 수 없어 저장하지 않았습니다.");
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const encrypted = this.encryption.encryptString(JSON.stringify({ version: 1, keys: next }));
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(temporary, encrypted, { mode: 0o600, flag: "wx" });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch {
      try { unlinkSync(temporary); } catch { /* No plaintext fallback. */ }
      throw new AppError("dictionary_key_storage", "사전 인증 키를 안전하게 저장하지 못했습니다.");
    }
    return status;
  }
}

let store: DictionaryCredentialStore | undefined;
function credentials(): DictionaryCredentialStore {
  try { return store ??= new DictionaryCredentialStore(join(app.getPath("userData"), "dictionary-keys.enc"), safeStorage); }
  catch { throw new AppError("dictionary_key_storage", "사전 인증 키 저장소를 열 수 없습니다."); }
}

export function getDictionaryKeyStatus(): KeyStatus { return credentials().status(); }
export function getDictionaryKey(keyProvider: DictionaryKeyProvider): string | null { return credentials().get(keyProvider); }
export function setDictionaryKey(input: DictionarySetKeyInput): KeyStatus { return credentials().set(input); }
