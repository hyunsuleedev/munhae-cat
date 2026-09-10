import type { ServerResponse } from "node:http";
import type { AccountState } from "../shared/munhae-api";
import { ACCOUNT_STATE_WIRE_LIMIT, accountStatePayload } from "../shared/account-state-wire";

type StateSource = {
  subscribe(listener: (state: AccountState) => void): () => void;
  getState(): Promise<AccountState>;
};

export function serveBrowserAuthEvents(res: ServerResponse, origin: string, source: StateSource, onClose: () => void): () => void {
  let closed = false;
  let revision = 0;
  let unsubscribe = () => undefined as void;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.off("close", close);
    res.off("error", close);
    res.end();
    onClose();
  };
  const send = (value: AccountState) => {
    if (closed) return;
    const state = accountStatePayload(value);
    if (!state) { close(); return; }
    const line = `${JSON.stringify(state)}\n`;
    // A disconnected or stalled reader must not accumulate account events.
    if (Buffer.byteLength(line) > ACCOUNT_STATE_WIRE_LIMIT || !res.write(line)) close();
  };
  res.writeHead(200, {
    "Access-Control-Allow-Origin": origin,
    "Cache-Control": "no-store, no-transform",
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "X-Accel-Buffering": "no",
    Vary: "Origin",
  });
  res.flushHeaders();
  res.on("close", close);
  res.on("error", close);
  // Subscribe before reading: a slow initial snapshot cannot undo a sign-out
  // (or account switch) that arrives while restoration is still completing.
  unsubscribe = source.subscribe((state) => { revision++; send(state); });
  if (closed) { unsubscribe(); return close; }
  const initialRevision = revision;
  void source.getState().then((state) => {
    if (revision === initialRevision) send(state);
  }).catch(() => { if (revision === initialRevision) close(); });
  heartbeat = setInterval(() => { if (!res.write("\n")) close(); }, 20_000);
  heartbeat.unref();
  return close;
}
