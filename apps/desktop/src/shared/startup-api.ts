export const STARTUP_CHANNELS = {
  wait: "munhae:startup:wait",
  enter: "munhae:startup:enter",
} as const;

export type StartupState = { ok: true } | { ok: false; message: string };

export type StartupApi = {
  wait(): Promise<StartupState>;
  enter(): Promise<void>;
};
