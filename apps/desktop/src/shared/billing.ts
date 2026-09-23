/** Server-owned subscription state. No credentials or Stripe customer identifiers cross IPC. */
export type BillingStatus = {
  plan: "free" | "premium";
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  configured: boolean;
};
