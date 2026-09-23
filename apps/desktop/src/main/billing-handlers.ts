import { shell } from "electron";
import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import { assertAuthenticatedUser, withAuthenticatedClient } from "./auth";
import { BillingService } from "./billing";
import { AppError } from "./errors";

export const BILLING_CHANNELS: IpcChannel[] = [IPC_CHANNELS.billingGetStatus, IPC_CHANNELS.billingOpenCheckout, IPC_CHANNELS.billingOpenPortal];
const service = new BillingService(withAuthenticatedClient, assertAuthenticatedUser, url => shell.openExternal(url));

export function dispatchBilling(channel: IpcChannel): Promise<unknown> {
  switch (channel) {
    case IPC_CHANNELS.billingGetStatus: return service.getStatus();
    case IPC_CHANNELS.billingOpenCheckout: return service.open("checkout");
    case IPC_CHANNELS.billingOpenPortal: return service.open("portal");
    default: throw new AppError("invalid_channel", "허용되지 않은 결제 요청입니다.");
  }
}
