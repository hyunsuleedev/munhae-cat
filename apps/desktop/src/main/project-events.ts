import { webContents } from "electron";
import type { ServerResponse } from "node:http";
import { IPC_CHANNELS, type ProjectChangeEvent } from "../shared/munhae-api";
import { assertAuthenticatedUser } from "./auth";
import { isAllowedNavigation } from "./security";

const listeners = new Set<(event: ProjectChangeEvent) => void>();
let latest: ProjectChangeEvent | null = null;
export function emitProjectChange(event: ProjectChangeEvent): void {
  assertAuthenticatedUser(event.accountId);
  latest = event;
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed() && isAllowedNavigation(contents.getURL())) contents.send(IPC_CHANNELS.projectChanged, event);
  }
  for (const listener of listeners) { try { listener(event); } catch { /* Isolate views. */ } }
}
export function serveProjectEvents(res: ServerResponse, origin: string, onClose: () => void): () => void {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = () => { if (closed) return; closed = true; clearInterval(heartbeat); listeners.delete(send); res.end(); onClose(); };
  const send = (event: ProjectChangeEvent) => {
    if (closed) return;
    try { assertAuthenticatedUser(event.accountId); } catch { close(); return; }
    const line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line) > 65536 || !res.write(line)) close();
  };
  res.writeHead(200, { "Access-Control-Allow-Origin": origin, "Cache-Control": "no-store, no-transform",
    "Content-Type": "application/x-ndjson; charset=utf-8", "X-Accel-Buffering": "no", Vary: "Origin" });
  res.flushHeaders(); res.on("close", close); res.on("error", close);
  listeners.add(send);
  if (latest) { try { assertAuthenticatedUser(latest.accountId); send(latest); } catch { /* No stale account event. */ } }
  if (!closed) { heartbeat = setInterval(() => { if (!res.write("\n")) close(); }, 20000); heartbeat.unref(); }
  return close;
}
