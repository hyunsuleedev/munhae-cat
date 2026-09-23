import type { BillingStatus, MunhaeApi } from "../../shared/munhae-api";
import { t, ui } from "./i18n";

type BillingState = {
  accountId: string | null;
  subscription: BillingStatus | null;
  loading: boolean;
  opening: "checkout" | "portal" | null;
  statusError: string;
  actionError: string;
  actionErrorCode: string;
};
const empty = (): BillingState => ({ accountId: null, subscription: null, loading: false, opening: null, statusError: "", actionError: "", actionErrorCode: "" });
const message = (error: unknown) => error instanceof Error ? error.message : t("결제 정보를 확인하지 못했습니다. 잠시 후 다시 시도하세요.");

export class BillingController {
  state = empty();
  private epoch = 0;
  constructor(private readonly api: MunhaeApi["billing"], private readonly changed: () => void) {}

  setAccount(accountId: string | null): void {
    if (accountId === this.state.accountId) return;
    this.epoch += 1;
    this.state = { ...empty(), accountId };
    this.changed();
  }

  async refresh(): Promise<void> {
    if (!this.state.accountId || this.state.loading || this.state.opening) return;
    const epoch = this.epoch;
    this.state.loading = true;
    this.state.statusError = "";
    this.changed();
    try {
      const result = await this.api.getStatus();
      if (epoch !== this.epoch) return;
      if (!result.ok) throw new Error(result.error.message);
      this.state.subscription = result.data;
    } catch (error) {
      if (epoch === this.epoch) this.state.statusError = message(error);
    } finally {
      if (epoch === this.epoch) { this.state.loading = false; this.changed(); }
    }
  }

  async open(action: "checkout" | "portal"): Promise<void> {
    if (!this.state.accountId || this.state.loading || this.state.opening || this.state.statusError || !this.state.subscription?.configured) return;
    const epoch = this.epoch;
    this.state.opening = action;
    this.state.actionError = "";
    this.state.actionErrorCode = "";
    this.changed();
    try {
      const result = await (action === "checkout" ? this.api.openCheckout() : this.api.openPortal());
      if (epoch !== this.epoch) return;
      if (!result.ok) {
        this.state.actionErrorCode = result.error.code;
        throw new Error(result.error.message);
      }
    } catch (error) {
      if (epoch === this.epoch) this.state.actionError = message(error);
    } finally {
      if (epoch === this.epoch) { this.state.opening = null; this.changed(); }
    }
  }
}

export function billingDetail(subscription: BillingStatus): string {
  if (!subscription.configured) return t("Stripe 연결 준비 중");
  if (subscription.status === "past_due" || subscription.status === "unpaid") return t("결제 확인이 필요합니다. 구독 관리에서 결제 수단을 확인하세요.");
  if (subscription.status === "incomplete") return t("결제가 완료되지 않았습니다.");
  if (subscription.status === "canceled") return t("구독이 종료되었습니다.");
  if (subscription.status === "paused") return t("구독이 일시 중지되었습니다.");
  if (subscription.plan !== "premium") return t("현재 무료 플랜을 사용하고 있습니다.");
  const date = subscription.currentPeriodEnd
    ? new Intl.DateTimeFormat(document.documentElement.lang === "en" ? "en-GB" : "ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(subscription.currentPeriodEnd)) : null;
  if (subscription.cancelAtPeriodEnd) return date ? ui`${date}까지 이용 후 구독이 종료됩니다.` : t("현재 이용 기간이 끝나면 구독이 종료됩니다.");
  return date ? ui`다음 결제일: ${date}` : t("Premium 구독이 활성화되어 있습니다.");
}

export function mountBilling(api: MunhaeApi["billing"]): { setAccount(id: string | null): void; render(disabled: boolean): void; refresh(): void } {
  const card = document.querySelector<HTMLElement>("#accountBilling")!;
  const plan = card.querySelector<HTMLElement>("#accountBillingPlan")!;
  const detail = card.querySelector<HTMLElement>("#accountBillingDetail")!;
  const error = card.querySelector<HTMLElement>("#accountBillingError")!;
  const checkout = card.querySelector<HTMLButtonElement>("#accountBillingCheckout")!;
  const portal = card.querySelector<HTMLButtonElement>("#accountBillingPortal")!;
  const refresh = card.querySelector<HTMLButtonElement>("#accountBillingRefresh")!;
  let accountBusy = false;
  const controller = new BillingController(api, render);

  function render(): void {
    const state = controller.state;
    const subscription = state.subscription;
    const pending = accountBusy || state.loading || state.opening !== null;
    const unavailable = !subscription?.configured || Boolean(state.statusError);
    card.hidden = !state.accountId;
    card.setAttribute("aria-busy", String(state.loading || state.opening !== null));
    plan.textContent = state.statusError ? t("확인할 수 없음") : subscription ? subscription.plan === "premium" ? "Premium" : t("무료") : t("확인 중…");
    detail.textContent = state.statusError ? "" : subscription ? billingDetail(subscription) : t("구독 정보를 확인하고 있습니다.");
    error.textContent = state.statusError || state.actionError;
    error.hidden = !error.textContent;
    const currentSubscription = subscription && subscription.status && !["canceled", "incomplete_expired"].includes(subscription.status);
    checkout.hidden = Boolean(currentSubscription || subscription?.plan === "premium");
    checkout.disabled = pending || unavailable;
    checkout.textContent = state.opening === "checkout" ? t("결제 페이지 여는 중…") : t("Premium 구독");
    portal.hidden = !subscription?.status && !["SUBSCRIPTION_EXISTS", "SUBSCRIPTION_PENDING"].includes(state.actionErrorCode);
    portal.disabled = pending || unavailable;
    portal.textContent = state.opening === "portal" ? t("구독 관리 여는 중…") : t("구독 · 청구서 관리");
    refresh.disabled = pending || !state.accountId;
    refresh.textContent = state.loading ? t("확인 중…") : t("새로고침");
  }
  checkout.addEventListener("click", () => { if (!accountBusy) void controller.open("checkout"); });
  portal.addEventListener("click", () => { if (!accountBusy) void controller.open("portal"); });
  refresh.addEventListener("click", () => { if (!accountBusy) void controller.refresh(); });
  return {
    setAccount(id) {
      const changed = id !== controller.state.accountId;
      controller.setAccount(id);
      if (changed && id) void controller.refresh();
    },
    render(disabled) { accountBusy = disabled; render(); },
    refresh() { if (!accountBusy) void controller.refresh(); },
  };
}
