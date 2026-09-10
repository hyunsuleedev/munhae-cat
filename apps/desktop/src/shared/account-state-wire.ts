import type { AccountState } from "./munhae-api";

export const ACCOUNT_STATE_WIRE_LIMIT = 32_768;

// Keep the development browser contract as narrow as native IPC. In particular,
// never serialize a Supabase session or extra fields carried by an auth object.
export function accountStatePayload(value: unknown): AccountState | null {
  if (!value || typeof value !== "object") return null;
  const state = value as Record<string, unknown>;
  if (state.status !== "signed_out" && state.status !== "signed_in" && state.status !== "password_recovery") return null;
  if (state.persistence !== "encrypted" && state.persistence !== "memory") return null;
  if (state.status === "signed_out") {
    if (state.user !== null) return null;
    return { status: "signed_out", user: null, persistence: state.persistence };
  }
  if (!state.user || typeof state.user !== "object") return null;
  const user = state.user as Record<string, unknown>;
  if (typeof user.id !== "string" || typeof user.email !== "string" || typeof user.displayName !== "string") return null;
  if (user.emailConfirmedAt !== null && typeof user.emailConfirmedAt !== "string") return null;
  if (!Array.isArray(user.providers) || user.providers.length > 2 || user.providers.some((provider) => provider !== "email" && provider !== "google")) return null;
  return {
    status: state.status as "signed_in" | "password_recovery",
    persistence: state.persistence,
    user: {
      id: user.id, email: user.email, displayName: user.displayName,
      emailConfirmedAt: user.emailConfirmedAt,
      providers: user.providers as Array<"email" | "google">,
    },
  };
}
