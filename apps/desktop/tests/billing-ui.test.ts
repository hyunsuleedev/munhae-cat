import { describe, expect, it, vi } from "vitest";
import { BillingController, billingDetail } from "../src/renderer/scripts/billing-ui";
import type { BillingStatus, IpcResult } from "../src/shared/munhae-api";

const free: BillingStatus = { plan: "free", status: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, configured: true };
const success = <T>(data: T): IpcResult<T> => ({ ok: true, data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const api = {
    getStatus: vi.fn(async (): Promise<IpcResult<BillingStatus>> => success(free)),
    openCheckout: vi.fn(async (): Promise<IpcResult<void>> => success(undefined)),
    openPortal: vi.fn(async (): Promise<IpcResult<void>> => success(undefined)),
  };
  const controller = new BillingController(api, vi.fn());
  controller.setAccount("account-a");
  return { api, controller };
}

describe("account billing state", () => {
  it("ignores late status and action failures after switching accounts", async () => {
    const { api, controller } = fixture();
    const response = deferred<IpcResult<BillingStatus>>();
    api.getStatus.mockReturnValueOnce(response.promise);
    const pending = controller.refresh();
    controller.setAccount("account-b");
    response.resolve(success({ ...free, plan: "premium" }));
    await pending;
    expect(controller.state.subscription).toBeNull();
    await controller.refresh();
    const checkout = deferred<IpcResult<void>>();
    api.openCheckout.mockReturnValueOnce(checkout.promise);
    const opening = controller.open("checkout");
    controller.setAccount(null);
    controller.setAccount("account-b");
    checkout.resolve({ ok: false, error: { code: "old", message: "old account error" } });
    await opening;
    expect(controller.state.actionError).toBe("");
    expect(controller.state.subscription).toBeNull();
    expect(controller.state.opening).toBeNull();
  });

  it("keeps unknown/error status distinct from free and requires configured billing", async () => {
    const { api, controller } = fixture();
    api.getStatus.mockRejectedValueOnce(new Error("offline"));
    await controller.refresh();
    expect(controller.state.subscription).toBeNull();
    expect(controller.state.statusError).toBe("offline");
    await controller.open("checkout");
    expect(api.openCheckout).not.toHaveBeenCalled();
    api.getStatus.mockResolvedValueOnce(success({ ...free, configured: false }));
    await controller.refresh();
    expect(billingDetail(controller.state.subscription!)).toBe("Stripe 연결 준비 중");
    await controller.open("checkout");
    expect(api.openCheckout).not.toHaveBeenCalled();
    await controller.refresh();
    await controller.open("checkout");
    expect(api.openCheckout).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate checkout and never upgrades the plan merely because a browser opened", async () => {
    const { api, controller } = fixture();
    await controller.refresh();
    const response = deferred<IpcResult<void>>();
    api.openCheckout.mockReturnValueOnce(response.promise);
    const opening = controller.open("checkout");
    await controller.open("checkout");
    expect(api.openCheckout).toHaveBeenCalledTimes(1);
    response.resolve(success(undefined));
    await opening;
    expect(controller.state.subscription?.plan).toBe("free");
    api.getStatus.mockResolvedValueOnce(success({ ...free, plan: "premium", status: "active" }));
    await controller.refresh();
    expect(controller.state.subscription?.plan).toBe("premium");
  });
});
