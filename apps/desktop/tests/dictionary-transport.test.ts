import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictionarySearchInput } from "../src/shared/dictionary-types";
import type { MunhaeApi } from "../src/shared/munhae-api";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  exposed: new Map<string, unknown>(),
  sender: {},
  request: null as null | ((req: unknown, res: unknown) => void),
  account: vi.fn(), key: vi.fn(), setKey: vi.fn(), online: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("electron", () => ({
  app: {}, dialog: {},
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => state.handlers.set(channel, handler) },
  contextBridge: { exposeInMainWorld: (key: string, value: unknown) => state.exposed.set(key, value) },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => state.handlers.get(channel)!({ sender: state.sender }, ...args),
    on: vi.fn(), removeListener: vi.fn(),
  },
}));
vi.mock("node:http", () => ({ createServer: (handler: (req: unknown, res: unknown) => void) => {
  state.request = handler;
  return { on: vi.fn(), listen: (_port: number, _host: string, callback: () => void) => callback(), close: vi.fn() };
} }));
vi.mock("../src/main/auth", () => ({
  withAccount: (action: (account: unknown) => unknown) => action({ getState: state.account }),
  withAuthenticatedClient: vi.fn(),
  subscribeAccountState: vi.fn(),
}));
vi.mock("../src/main/dictionary-credentials", () => ({
  getDictionaryKey: state.key, setDictionaryKey: state.setKey,
  getDictionaryKeyStatus: () => ({ opendict: true, stdict: false }),
}));
vi.mock("../src/main/dictionary-online", () => ({ searchOnlineDictionary: state.online }));
vi.mock("../src/main/dictionary-local", () => ({
  getLocalDictionaryDatasets: () => [],
  searchLocalDictionary: (query: string, page: number) => ({ query, page, provider: "local", entries: [], notices: [], total: 0, hasMore: false }),
}));
vi.mock("../src/main/window", () => ({ getMainWindow: () => ({ isDestroyed: () => false, webContents: state.sender }) }));
vi.mock("../src/main/session", () => ({
  getAppConfig: () => ({ language: "ko" }),
  getRuntimeSessionRef: vi.fn(), setRuntimeSessionRef: vi.fn(), clearRuntimeSession: vi.fn(),
  onlineSaveRequestKey: () => undefined,
  withOnlineProjectSave: async <T>(operation: () => T | Promise<T>): Promise<T> => await operation(),
}));
vi.mock("../src/main/log", () => ({ log: state.log, redact: (value: string) => value }));
vi.mock("../src/main/agents", () => ({}));
vi.mock("../src/main/itkc-footnotes", () => ({}));
vi.mock("../src/main/footnote-analysis", () => ({}));
vi.mock("../src/main/reading-analysis", () => ({}));
vi.mock("../src/main/reference-assets", () => ({}));
vi.mock("../src/main/security", () => ({}));
vi.mock("../src/main/ai-runs", () => ({ persistAiBeforeLaunch: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/main/agent-runtime-client", () => ({}));
vi.mock("../src/main/auth-handlers", () => ({ ACCOUNT_CHANNELS: [] }));
vi.mock("../src/main/billing-handlers", () => ({ BILLING_CHANNELS: [] }));
vi.mock("../src/main/browser-auth-events", () => ({}));

import { registerIpcHandlers } from "../src/main/ipc";
import { startBrowserBridge, stopBrowserBridge } from "../src/main/browser-bridge";
import { IPC_CHANNELS } from "../src/shared/munhae-api";
import { createBrowserApi } from "../src/renderer/scripts/browser-api";
import "../src/preload/index";

function bridgeRequest(body: string, origin = "http://localhost:5173"): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    let status = 0;
    state.request!({
      headers: { origin, host: "127.0.0.1:17321" }, method: "POST", url: "/api",
      async *[Symbol.asyncIterator]() { yield Buffer.from(body); },
    }, {
      writeHead: (value: number) => { status = value; },
      end: (responseBody: string) => { resolve({ status, body: responseBody }); },
    });
  });
}

beforeAll(() => { registerIpcHandlers(); });
beforeEach(() => {
  vi.clearAllMocks();
  state.account.mockResolvedValue({ status: "signed_in", user: { id: "account-1" } });
  state.key.mockReturnValue("a".repeat(32));
  state.setKey.mockReturnValue({ opendict: true, stdict: false });
  state.online.mockImplementation(async (input: DictionarySearchInput) => ({
    ...input, entries: [], notices: [], total: 0, hasMore: false,
  }));
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173");
  startBrowserBridge();
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options: RequestInit) => {
    const result = await bridgeRequest(String(options.body));
    return new Response(result.body, { status: result.status, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { stopBrowserBridge(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe.each(["native", "browser"] as const)("dictionary %s transport", (transport) => {
  const api = (): MunhaeApi => transport === "native" ? state.exposed.get("munhae") as MunhaeApi : createBrowserApi();

  it("connects all three typed methods to main and returns no credential", async () => {
    const dictionary = api().dictionary;
    expect(await dictionary.search({ query: " 目 ", provider: "local" })).toMatchObject({
      ok: true, data: { query: "目", provider: "local", page: 1 },
    });
    expect(await dictionary.getStatus()).toEqual({ ok: true, data: { datasets: [], keys: { opendict: true, stdict: false } } });
    const saved = await dictionary.setKey({ provider: "opendict", apiKey: "a".repeat(32) });
    expect(saved).toEqual({ ok: true, data: { datasets: [], keys: { opendict: true, stdict: false } } });
    expect(JSON.stringify(saved)).not.toContain("a".repeat(32));
    await dictionary.search({ query: "太守", provider: "opendict", page: 2 });
    expect(state.online).toHaveBeenCalledWith({ query: "太守", provider: "opendict", page: 2 }, "a".repeat(32));
  });

  it("returns an auth failure before any provider or credential action", async () => {
    state.account.mockResolvedValue({ status: "signed_out", user: null });
    const dictionary = api().dictionary;
    for (const result of [
      await dictionary.search({ query: "目", provider: "opendict" }),
      await dictionary.getStatus(),
      await dictionary.setKey({ provider: "opendict", apiKey: "a".repeat(32) }),
    ]) expect(result).toMatchObject({ ok: false, error: { code: "auth_required" } });
    for (const fn of [state.key, state.setKey, state.online]) expect(fn).not.toHaveBeenCalled();
  });

  it("returns structured validation errors and keeps failed key writes out of responses and logs", async () => {
    const dictionary = api().dictionary;
    expect(await dictionary.search({ query: "目", provider: "local", page: 101 }))
      .toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    const apiKey = "a".repeat(32);
    state.setKey.mockImplementation(() => { throw new Error(`failed writing ${apiKey}`); });
    const result = await dictionary.setKey({ provider: "opendict", apiKey });
    expect(result).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(JSON.stringify([result, state.log.warn.mock.calls, state.log.error.mock.calls])).not.toContain(apiKey);
  });
});

it("retains native sender and browser origin checks for the new channels", async () => {
  const result = await state.handlers.get(IPC_CHANNELS.dictionaryGetStatus)!({ sender: {} });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_sender" } });
  const response = await bridgeRequest(JSON.stringify({ channel: IPC_CHANNELS.dictionaryGetStatus, args: [] }), "https://example.com");
  expect(response).toEqual({ status: 403, body: JSON.stringify({ error: "forbidden" }) });
  expect(state.account).not.toHaveBeenCalled();
});
