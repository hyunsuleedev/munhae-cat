import { IPC_CHANNELS, type IpcChannel } from "../shared/munhae-api";
import { cancelGoogleSignIn, invalidateAuthenticatedRequests, signInWithGoogle, withAccount } from "./auth";
import { accountCredentials, accountEmail, accountPassword, accountSignUp, accountVerification } from "./auth-validation";
import { AppError } from "./errors";
import { prepareOnlineAccountChange } from "./session";

export const ACCOUNT_CHANNELS: IpcChannel[] = [
  IPC_CHANNELS.authGetState, IPC_CHANNELS.authSignUp, IPC_CHANNELS.authSignIn,
  IPC_CHANNELS.authSignOut, IPC_CHANNELS.authVerifyCode, IPC_CHANNELS.authResendConfirmation,
  IPC_CHANNELS.authRequestPasswordReset, IPC_CHANNELS.authUpdatePassword,
  IPC_CHANNELS.authSignInWithGoogle, IPC_CHANNELS.authCancelGoogleSignIn,
];

export async function dispatchAccount(channel: IpcChannel, input?: unknown): Promise<unknown> {
  const credentialChannels: IpcChannel[] = [IPC_CHANNELS.authSignUp, IPC_CHANNELS.authSignIn,
    IPC_CHANNELS.authSignInWithGoogle, IPC_CHANNELS.authSignOut,
    IPC_CHANNELS.authVerifyCode, IPC_CHANNELS.authUpdatePassword];
  if (credentialChannels.includes(channel)) await prepareOnlineAccountChange();
  const finish = credentialChannels.includes(channel) ? invalidateAuthenticatedRequests() : undefined;
  try {
    return await withAccount<unknown>((account) => {
      switch (channel) {
        case IPC_CHANNELS.authGetState: return account.getState();
        case IPC_CHANNELS.authSignUp: return account.signUp(accountSignUp(input));
        case IPC_CHANNELS.authSignIn: return account.signIn(accountCredentials(input));
        case IPC_CHANNELS.authSignInWithGoogle: return signInWithGoogle();
        case IPC_CHANNELS.authCancelGoogleSignIn: return Promise.resolve(cancelGoogleSignIn());
        case IPC_CHANNELS.authSignOut: cancelGoogleSignIn(); return account.signOut();
        case IPC_CHANNELS.authVerifyCode: return account.verifyCode(accountVerification(input));
        case IPC_CHANNELS.authResendConfirmation: return account.resendConfirmation(accountEmail(input));
        case IPC_CHANNELS.authRequestPasswordReset: return account.requestPasswordReset(accountEmail(input));
        case IPC_CHANNELS.authUpdatePassword: return account.updatePassword(accountPassword(input));
        default: throw new AppError("invalid_channel", "허용되지 않은 계정 요청입니다.");
      }
    });
  } finally {
    finish?.();
  }
}
