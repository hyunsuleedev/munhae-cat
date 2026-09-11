import { join } from "node:path";
import { app, BrowserWindow, safeStorage, shell } from "electron";
import { createClient } from "@supabase/supabase-js";
import { IPC_CHANNELS, type AccountState } from "../shared/munhae-api";
import { AccountService, throwAccountError } from "./account-service";
import { MUNHAE_SUPABASE_PUBLISHABLE_KEY, MUNHAE_SUPABASE_URL } from "./auth-config";
import { AccountStorage } from "./auth-storage";
import { AppError } from "./errors";
import { focusMainWindow } from "./window";
import { GoogleOAuth } from "./google-oauth";
import { isAllowedNavigation } from "./security";

let service: AccountService | null = null;
let google: GoogleOAuth | null = null;
const stateListeners = new Set<(state: AccountState) => void>();

/** Change-only subscription; callers can subscribe before reading getState(). */
export function subscribeAccountState(listener: (state: AccountState) => void): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

function publishAccountState(state: AccountState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    const contents = window.webContents;
    if (!contents.isDestroyed() && isAllowedNavigation(contents.getURL())) {
      contents.send(IPC_CHANNELS.authStateChanged, state);
    }
  }
  for (const listener of stateListeners) {
    try { listener(state); } catch { /* A disconnected subscriber cannot break authentication. */ }
  }
}

export async function initAccount(): Promise<void> {
  const storage = new AccountStorage(join(app.getPath("userData"), "account-session.enc"), safeStorage);
  const client = createClient(MUNHAE_SUPABASE_URL, MUNHAE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { storage, storageKey: "munhae-official-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: "pkce" },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  });
  service = new AccountService(client.auth, storage, publishAccountState);
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
  // Restore and verify once without delaying window creation. All pages then
  // read the main-owned snapshot; SDK refresh events keep it current.
  void service.getState().catch(() => { /* The global auth gate offers retry. */ });
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
  stateListeners.clear();
}
