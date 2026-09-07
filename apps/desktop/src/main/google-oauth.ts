import { randomBytes, createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccountState } from "../shared/munhae-api";
import { AppError } from "./errors";
import { MUNHAE_SUPABASE_URL } from "./auth-config";

type OAuthClient = Pick<SupabaseClient["auth"], "signInWithOAuth" | "exchangeCodeForSession">;
type SessionTokens = { access_token: string; refresh_token: string };
type Options = {
  createAuth: () => OAuthClient;
  openBrowser: (url: string) => Promise<void>;
  acceptSession: (tokens: SessionTokens) => Promise<AccountState>;
  onComplete?: () => void;
  timeoutMs?: number;
};

// The callback exists only during a login attempt, on an OS-assigned loopback port.
// A random path binds the browser response to that attempt, in addition to PKCE.
export const GOOGLE_REDIRECT_ALLOWLIST = "http://127.0.0.1:*/auth/google/callback/*";
const FRAGMENT_ERROR_SCRIPT = `const p=new URLSearchParams(location.hash.slice(1));const e=p.get('error')==='access_denied'?'access_denied':'invalid_callback';location.replace(location.pathname+'?error='+e);`;
const SCRIPT_HASH = createHash("sha256").update(FRAGMENT_ERROR_SCRIPT).digest("base64");

function page(res: ServerResponse, status: number, title: string, message: string, fragment = false): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${SCRIPT_HASH}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    Connection: "close",
  });
  // Only static application text reaches this page; provider error strings are never rendered.
  res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>munhae cat studio</title><style>body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#20252b;margin:0;padding:12vh 24px}main{max-width:420px;margin:auto;padding:32px;background:white;border:1px solid #e4e7eb;border-radius:14px}small{color:#616b77}h1{font-size:24px}p{line-height:1.7}</style><main><small>munhae cat studio</small><h1>${title}</h1><p>${message}</p></main>${fragment ? `<script>${FRAGMENT_ERROR_SCRIPT}</script>` : ""}</html>`);
}

export class GoogleOAuth {
  private pending: { server: Server; cancel: () => void; exchanging: boolean } | null = null;
  constructor(private readonly options: Options) {}

  cancel(): boolean {
    if (!this.pending) return false;
    if (this.pending.exchanging) throw new AppError("oauth_completing", "로그인을 완료하고 있습니다. 잠시만 기다려 주세요.");
    this.pending.cancel();
    return true;
  }

  start(): Promise<AccountState> {
    if (this.pending) return Promise.reject(new AppError("oauth_in_progress", "이미 구글 로그인을 진행하고 있습니다."));
    const path = `/auth/google/callback/${randomBytes(32).toString("hex")}`;
    const auth = this.options.createAuth();
    return new Promise<AccountState>((resolve, reject) => {
      let settled = false;
      let port = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, state?: AccountState): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        if (this.pending?.server === server) this.pending = null;
        if (error) reject(error);
        else if (state) {
          resolve(state);
          try { this.options.onComplete?.(); } catch { /* Restoring focus must not invalidate a saved login. */ }
        }
      };
      const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (req, res) => {
        let url: URL;
        try { url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`); }
        catch { page(res, 400, "유효하지 않은 요청", "앱에서 구글 로그인을 다시 시작하세요."); return; }
        if (settled || req.headers.host !== `127.0.0.1:${port}` || url.pathname !== path) {
          page(res, 404, "유효하지 않은 요청", "앱에서 구글 로그인을 다시 시작하세요."); return;
        }
        if (req.method !== "GET") { page(res, 405, "유효하지 않은 요청", "앱에서 구글 로그인을 다시 시작하세요."); return; }
        if (this.pending?.exchanging) { page(res, 409, "로그인 확인 중", "문해 앱에서 결과를 확인하세요."); return; }
        if (url.searchParams.has("error")) {
          const denied = url.searchParams.get("error") === "access_denied";
          page(res, 200, denied ? "로그인을 취소했습니다" : "로그인을 완료하지 못했습니다", "문해 앱으로 돌아가 다시 시도할 수 있습니다.");
          finish(new AppError(denied ? "oauth_cancelled" : "oauth_failed", denied ? "구글 로그인을 취소했습니다." : "구글 인증을 완료하지 못했습니다. 다시 시도하세요.")); return;
        }
        const code = url.searchParams.get("code");
        if (!code) { page(res, 200, "로그인 확인 중", "문해 앱에서 인증 결과를 확인하세요.", true); return; }
        if (url.searchParams.getAll("code").length !== 1 || !/^[A-Za-z0-9._~-]{8,2048}$/.test(code)) {
          page(res, 400, "유효하지 않은 인증 응답", "앱에서 구글 로그인을 다시 시작하세요."); return;
        }
        if (this.pending) this.pending.exchanging = true;
        clearTimeout(timer);
        void (async () => {
          try {
            const { data, error } = await auth.exchangeCodeForSession(code);
            if (settled) { page(res, 410, "로그인이 종료되었습니다", "문해 앱에서 다시 시작하세요."); return; }
            if (error) throw error;
            if (!data.session) throw new AppError("oauth_failed", "구글 인증을 완료하지 못했습니다.");
            // Discard Google provider tokens. Only the official Supabase session is retained.
            const state = await this.options.acceptSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
            page(res, 200, "로그인되었습니다", "문해 앱으로 돌아가 작업을 계속하세요. 이 탭은 닫아도 됩니다.");
            finish(undefined, state);
          } catch (error) {
            page(res, 200, "로그인을 완료하지 못했습니다", "문해 앱으로 돌아가 다시 시도하세요.");
            finish(error);
          }
        })();
      });
      this.pending = { server, exchanging: false, cancel: () => finish(new AppError("oauth_cancelled", "구글 로그인을 취소했습니다.")) };
      server.once("error", () => finish(new AppError("oauth_listener_failed", "로그인 연결을 준비하지 못했습니다. 다시 시도하세요.")));
      server.listen(0, "127.0.0.1", () => {
        if (settled) { server.close(); return; }
        const address = server.address();
        if (!address || typeof address === "string") { finish(new AppError("oauth_listener_failed", "로그인 연결을 준비하지 못했습니다.")); return; }
        port = address.port;
        timer = setTimeout(() => finish(new AppError("oauth_timeout", "구글 로그인 대기 시간이 지났습니다. 다시 시도하세요.")), this.options.timeoutMs ?? 300_000);
        timer.unref();
        void (async () => {
          try {
            const { data, error } = await auth.signInWithOAuth({ provider: "google", options: {
              redirectTo: `http://127.0.0.1:${port}${path}`, skipBrowserRedirect: true,
              scopes: "openid email profile", queryParams: { prompt: "select_account" },
            } });
            if (error) throw error;
            if (settled) return;
            const url = new URL(data.url ?? "");
            if (url.origin !== MUNHAE_SUPABASE_URL || url.pathname !== "/auth/v1/authorize" || url.searchParams.get("provider") !== "google") {
              throw new AppError("oauth_invalid_url", "올바른 구글 로그인 주소를 받지 못했습니다.");
            }
            await this.options.openBrowser(url.toString());
          } catch (error) { finish(error); }
        })();
      });
    });
  }

  dispose(): void { this.pending?.cancel(); }
}
