import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import { createClient } from "@supabase/supabase-js";
import { IPC_CHANNELS, type AccountState } from "../shared/munhae-api";
import { AccountService, throwAccountError } from "./account-service";
import { MUNHAE_SUPABASE_PUBLISHABLE_KEY, MUNHAE_SUPABASE_URL } from "./auth-config";
import { AccountStorage } from "./auth-storage";
import { AppError } from "./errors";
import { focusMainWindow, getMainWindow } from "./window";
import { GoogleOAuth } from "./google-oauth";

let service: AccountService | null = null;
let google: GoogleOAuth | null = null;

export async function initAccount(): Promise<void> {
  const storage = new AccountStorage(join(app.getPath("userData"), "account-session.enc"), safeStorage);
  const client = createClient(MUNHAE_SUPABASE_URL, MUNHAE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage, storageKey: "munhae-official-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  });
  service = new AccountService(client.auth, storage, (state) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.authStateChanged, state);
  });
  google = new GoogleOAuth({
    // Each attempt owns a separate in-memory PKCE verifier and Google provider tokens.
    createAuth: () => createClient(MUNHAE_SUPABASE_URL, MUNHAE_SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "pkce" },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
    }).auth,
    openBrowser: (url) => shell.openExternal(url),
    acceptSession: (tokens) => withAccount((account) => account.acceptGoogleSession(tokens)),
    onComplete: focusMainWindow,
  });
  client.auth.startAutoRefresh();
  // A temporary network failure must not prevent opening the desktop window.
  void service.getState().catch(() => { /* Account UI offers retry. */ });
}

export async function withAccount<T>(action: (account: AccountService) => Promise<T>): Promise<T> {
  if (!service) throw new AppError("auth_not_ready", "계정 연결을 준비 중입니다. 잠시 후 다시 시도하세요.");
  try { return await action(service); } catch (error) { throwAccountError(error); }
}

export async function signInWithGoogle(): Promise<AccountState> {
  if (!google) throw new AppError("auth_not_ready", "계정 연결을 준비 중입니다.");
  try { return await google.start(); } catch (error) { throwAccountError(error); }
}

export function cancelGoogleSignIn(): boolean { return google?.cancel() ?? false; }

export function shutdownAccount(): void {
  google?.dispose();
  google = null;
  service?.dispose();
  service = null;
}
