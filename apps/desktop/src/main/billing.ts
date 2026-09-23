import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingStatus } from "../shared/billing";
import { AppError } from "./errors";

type AuthenticatedAccess = <T>(action: (client: SupabaseClient, userId: string) => Promise<T>) => Promise<T>;
type BillingAction = "status" | "checkout" | "portal";

const unavailable = () => new AppError("billing_unavailable", "결제 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요.");
const billingErrors: Record<string, string> = {
  AUTH_REQUIRED: "결제를 계속하려면 문해 계정으로 다시 로그인하세요.",
  BILLING_NOT_CONFIGURED: "Stripe 연결 준비 중",
  BILLING_BUSY: "다른 결제 요청을 처리 중입니다. 잠시 후 다시 시도하세요.",
  SUBSCRIPTION_EXISTS: "이미 구독이 있습니다. 새로고침하거나 구독 관리를 열어 주세요.",
  SUBSCRIPTION_PENDING: "결제 결과를 확인 중입니다. 잠시 후 새로고침하세요.",
  BILLING_CUSTOMER_NOT_FOUND: "아직 결제 내역이 없습니다. Premium 구독을 먼저 시작하세요.",
  BILLING_CUSTOMER_REVIEW_REQUIRED: "결제 계정 확인이 필요합니다. 문해 지원팀에 문의하세요.",
  BILLING_CHECKOUT_REVIEW_REQUIRED: "이전 결제 요청 확인이 필요합니다. 문해 지원팀에 문의하세요.",
};

async function providerError(error: unknown): Promise<AppError> {
  const context = error && typeof error === "object" ? (error as { context?: unknown }).context : null;
  if (context instanceof Response) {
    const data: unknown = await context.clone().json().catch(() => null);
    const code = data && typeof data === "object" ? (data as { error?: unknown }).error : null;
    if (typeof code === "string" && Object.hasOwn(billingErrors, code)) return new AppError(code, billingErrors[code]!);
  }
  return unavailable();
}

function readStatus(value: unknown): BillingStatus {
  if (!value || typeof value !== "object") throw unavailable();
  const row = value as Record<string, unknown>;
  if ((row.plan !== "free" && row.plan !== "premium")
    || (row.status !== null && (typeof row.status !== "string" || row.status.length > 64))
    || (row.currentPeriodEnd !== null && (typeof row.currentPeriodEnd !== "string" || !Number.isFinite(Date.parse(row.currentPeriodEnd))))
    || typeof row.cancelAtPeriodEnd !== "boolean" || typeof row.configured !== "boolean") throw unavailable();
  return { plan: row.plan, status: row.status, currentPeriodEnd: row.currentPeriodEnd, cancelAtPeriodEnd: row.cancelAtPeriodEnd, configured: row.configured };
}

/** Only Stripe-hosted pages may be opened; reject authority normalization tricks too. */
export function stripeBillingUrl(value: unknown, action: "checkout" | "portal"): string {
  if (typeof value !== "string" || value.length > 8192 || /[\s\\]/.test(value)) throw unavailable();
  const host = action === "checkout" ? "checkout.stripe.com" : "billing.stripe.com";
  if (!value.startsWith(`https://${host}/`)) throw unavailable();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port) throw unavailable();
    return url.href;
  } catch { throw unavailable(); }
}

export class BillingService {
  constructor(private readonly access: AuthenticatedAccess,
    private readonly assertUser: (userId: string) => void,
    private readonly openExternal: (url: string) => Promise<void>) {}

  private async invoke(action: BillingAction): Promise<{ data: unknown; userId: string }> {
    return this.access(async (client, userId) => {
      const { data, error } = await client.functions.invoke("billing", { body: { action } });
      // Never forward provider errors or session URLs to the renderer or logs.
      if (error) throw await providerError(error);
      return { data, userId };
    });
  }

  async getStatus(): Promise<BillingStatus> {
    const { data } = await this.invoke("status");
    return readStatus(data);
  }

  async open(action: "checkout" | "portal"): Promise<void> {
    const { data, userId } = await this.invoke(action);
    const url = stripeBillingUrl(data && typeof data === "object" ? (data as { url?: unknown }).url : null, action);
    // The authenticated request checks its session epoch through completion. This
    // final synchronous check covers account changes before the browser side effect.
    this.assertUser(userId);
    try { await this.openExternal(url); }
    catch { throw new AppError("billing_browser_failed", "결제 페이지를 열지 못했습니다. 다시 시도하세요."); }
  }
}
