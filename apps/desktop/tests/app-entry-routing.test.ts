import { afterEach, expect, it, vi } from "vitest";

type GateCallbacks = { reveal(): void; requireAccount(): void };
const gate = vi.hoisted(() => ({
  view: undefined as GateCallbacks | undefined,
  start: vi.fn(async () => undefined),
  check: vi.fn(async () => undefined),
  dispose: vi.fn(),
}));

vi.mock("../src/renderer/scripts/auth-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/scripts/auth-gate")>();
  return {
    ...actual,
    AuthGate: class {
      constructor(_auth: unknown, view: GateCallbacks) { gate.view = view; }
      start = gate.start;
      check = gate.check;
      dispose = gate.dispose;
    },
  };
});
vi.mock("../src/renderer/scripts/browser-api", () => ({ createBrowserApi: vi.fn() }));
vi.mock("../src/renderer/scripts/page-transition", () => ({
  installPageTransition: () => ({ pending: vi.fn(), finish: vi.fn(), dispose: vi.fn() }),
}));

class Element extends EventTarget {
  hidden = true;
  textContent = "";
  className = "";
  innerHTML = "";
  setAttribute = vi.fn();
  children = new Map<string, Element>();
  querySelector = (selector: string) => this.children.get(selector) ?? null;
}

afterEach(() => { vi.unstubAllGlobals(); });

it("preserves the current Account settings section when authentication ends after an in-page navigation", async () => {
  vi.resetModules();
  const panel = new Element();
  const button = new Element();
  panel.children.set("p", new Element());
  panel.children.set("button", button);
  const body = { dataset: {} as Record<string, string>, append: vi.fn() };
  const location = { pathname: "/settings.html", search: "", hash: "", replace: vi.fn() };
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    munhae: { auth: {} }, setTimeout: vi.fn(() => 1), clearTimeout: vi.fn(),
  }));
  vi.stubGlobal("document", {
    documentElement: {}, body,
    createElement: () => panel,
    querySelector: () => panel,
  });

  // Run production boot and its registered callbacks. The settings module
  // stays outside this route test; its authenticated reveal is simulated.
  await import("../src/renderer/scripts/app-entry");
  expect(gate.start).toHaveBeenCalledOnce();
  gate.view!.reveal();
  expect(body.dataset.authPending).toBeUndefined();
  expect(location.replace).not.toHaveBeenCalled();

  location.hash = "#account";
  gate.view!.requireAccount();
  expect(body.dataset.authPending).toBe("");
  expect(location.replace).toHaveBeenCalledExactlyOnceWith("account.html?next=settings.html%23account");

  // The fallback Login button must use the same current location as the
  // automatic redirect if navigation has not completed yet.
  button.dispatchEvent(new Event("click"));
  expect(location.replace).toHaveBeenCalledTimes(2);
  expect(location.replace).toHaveBeenLastCalledWith("account.html?next=settings.html%23account");
});
