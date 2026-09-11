import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountState } from "../src/shared/munhae-api";
import { serveBrowserAuthEvents } from "../src/main/browser-auth-events";
import { createBrowserAccountEvents } from "../src/renderer/scripts/browser-auth-events";

const signedIn: AccountState = {
  status: "signed_in", persistence: "encrypted",
  user: { id: "reader", email: "reader@example.invalid", displayName: "번역가", emailConfirmedAt: null, providers: ["email"] },
};
const signedOut: AccountState = { status: "signed_out", persistence: "encrypted", user: null };
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

function serverFixture() {
  let resolveInitial!: (state: AccountState) => void;
  let emit = (_state: AccountState) => undefined as void;
  const unsubscribe = vi.fn();
  const onClose = vi.fn();
  const res = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(), flushHeaders: vi.fn(), write: vi.fn(() => true), end: vi.fn(),
  });
  const close = serveBrowserAuthEvents(res as unknown as ServerResponse, "http://localhost:5173", {
    subscribe: (listener) => { emit = listener; return unsubscribe; },
    getState: () => new Promise((resolve) => { resolveInitial = resolve; }),
  }, onClose);
  return { res, close, unsubscribe, onClose, emit: (state: AccountState) => emit(state), initial: (state: AccountState) => resolveInitial(state) };
}

function browserFixture() {
  vi.useFakeTimers();
  const streams: Array<{ controller: ReadableStreamDefaultController<Uint8Array>; signal: AbortSignal }> = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init!.signal!;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start: (next) => { controller = next; },
    });
    signal.addEventListener("abort", () => { try { controller.error(new Error("aborted")); } catch { /* Already closed. */ } });
    streams.push({ controller, signal });
    return new Response(stream, { status: 200 });
  });
  const events = createBrowserAccountEvents(fetcher as typeof fetch);
  const send = (state: AccountState, index = streams.length - 1) => streams[index]!.controller.enqueue(new TextEncoder().encode(`${JSON.stringify(state)}\n`));
  return { events, streams, fetcher, send };
}

afterEach(() => { vi.useRealTimers(); });

describe("main-process account event stream", () => {
  it("does not send an older initial snapshot after a new account event", async () => {
    const f = serverFixture();
    f.emit(signedOut);
    f.initial(signedIn);
    await flush();
    expect(f.res.write.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([signedOut]);
    f.close();
  });

  it("projects only AccountState fields and closes subscriptions on disconnect", async () => {
    const f = serverFixture();
    f.initial({ ...signedIn, access_token: "DO_NOT_SEND", user: { ...signedIn.user, refresh_token: "DO_NOT_SEND" } } as unknown as AccountState);
    await flush();
    expect(f.res.write.mock.calls).toEqual([[`${JSON.stringify(signedIn)}\n`]]);
    f.res.emit("close");
    f.close();
    expect(f.unsubscribe).toHaveBeenCalledOnce();
    expect(f.onClose).toHaveBeenCalledOnce();
    f.emit(signedOut);
    expect(f.res.write).toHaveBeenCalledTimes(1);
  });

  it("bounds event payloads and closes a stalled reader", () => {
    const large = serverFixture();
    large.emit({ ...signedIn, user: { ...signedIn.user!, displayName: "한".repeat(32_768) } });
    expect(large.res.write).not.toHaveBeenCalled();
    expect(large.unsubscribe).toHaveBeenCalledOnce();
    const stalled = serverFixture();
    stalled.res.write.mockReturnValue(false);
    stalled.emit(signedIn);
    expect(stalled.unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps an idle connection alive and stops heartbeats on shutdown", () => {
    vi.useFakeTimers();
    const f = serverFixture();
    vi.advanceTimersByTime(20_000);
    expect(f.res.write.mock.calls).toEqual([["\n"]]);
    f.close();
    vi.advanceTimersByTime(60_000);
    expect(f.res.write).toHaveBeenCalledOnce();
  });
});

describe("development browser account event subscriptions", () => {
  it("shares one stream, fans out events, and releases it after the final subscriber", async () => {
    const f = browserFixture();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = f.events.subscribe(first);
    await flush();
    f.send(signedIn);
    await flush();
    const stopSecond = f.events.subscribe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith(signedIn);
    stopFirst();
    expect(f.streams[0]!.signal.aborted).toBe(false);
    f.send(signedOut);
    await flush();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith(signedOut);
    stopSecond();
    expect(f.streams[0]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("reconnects after loss without inventing a signed-out state", async () => {
    const f = browserFixture();
    const handler = vi.fn();
    const stop = f.events.subscribe(handler);
    await flush();
    f.send(signedIn);
    await flush();
    f.streams[0]!.controller.error(new Error("offline"));
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.send(signedOut);
    await flush();
    expect(handler).toHaveBeenLastCalledWith(signedOut);
    stop();
  });

  it("ignores blank heartbeats and rejects malformed or oversized frames", async () => {
    const f = browserFixture();
    const handler = vi.fn();
    const stop = f.events.subscribe(handler);
    await flush();
    f.streams[0]!.controller.enqueue(new TextEncoder().encode("\n\n{\"status\":\"signed_out\"}\n"));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    f.streams[1]!.controller.enqueue(new TextEncoder().encode("x".repeat(32_769)));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    stop();
  });

  it("cancels queued reconnects and never lets an old connection overwrite a new one", async () => {
    const f = browserFixture();
    const old = vi.fn();
    const stopOld = f.events.subscribe(old);
    await flush();
    f.send(signedIn);
    stopOld();
    const current = vi.fn();
    const stop = f.events.subscribe(current);
    await flush();
    expect(old).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    f.send(signedOut);
    await flush();
    expect(current).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
