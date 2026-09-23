import { afterEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type IpcResult, type ProjectSummary } from "../src/shared/munhae-api";

type OpenResult = IpcResult<ProjectSummary | null>;
type Surface = "browser" | "native";

const project: ProjectSummary = {
  projectId: "selected-project",
  title: "번역 연구",
  packagePath: "/projects/research.munhae",
  storageMode: "local",
  openedAt: "2026-09-10T00:00:00.000Z",
};

async function fixture(surface: Surface, result: OpenResult, authPending = false) {
  vi.resetModules();
  const nativeOpen = vi.fn(async () => result);
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ value: result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  const notification = { classList: { add: vi.fn(), remove: vi.fn() } };
  const title = { textContent: "" };
  const message = { textContent: "" };
  const elements = new Map<string, unknown>([["#notif", notification], ["#nTitle", title], ["#nMsg", message]]);
  const location = { href: "index.html" };
  const window = {
    ...(surface === "native" ? { munhae: { project: { open: nativeOpen } } } : {}),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  };
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("window", window);
  vi.stubGlobal("location", location);
  vi.stubGlobal("document", {
    body: { hasAttribute: (name: string) => name === "data-auth-pending" && authPending },
    querySelector: (selector: string) => elements.get(selector) ?? null,
  });

  // Exercise the production command, transition helper and browser transport.
  // Only the outside-world boundary and notification elements are substituted.
  const { cmd } = await import("../src/renderer/scripts/shared");
  return { cmd, nativeOpen, fetcher, notification, title, message, location, window };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("project Open from the shared command", () => {
  it("sends a bridge request from a browser without Electron preload and navigates after success", async () => {
    const f = await fixture("browser", { ok: true, data: project });
    await f.cmd("open");

    expect("munhae" in f.window).toBe(false);
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith("/__munhae/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: IPC_CHANNELS.projectOpen, args: [null] }),
    });
    expect(f.nativeOpen).not.toHaveBeenCalled();
    expect(f.location.href).toBe("home.html");
  });

  it("uses the Electron preload API when available without making a browser request", async () => {
    const f = await fixture("native", { ok: true, data: project });
    await f.cmd("open");

    expect(f.nativeOpen).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.location.href).toBe("home.html");
  });

  it.each(["browser", "native"] as const)("stays on the welcome screen when the %s file chooser is cancelled", async surface => {
    const f = await fixture(surface, { ok: true, data: null });
    await f.cmd("open");

    expect(surface === "browser" ? f.fetcher : f.nativeOpen).toHaveBeenCalledOnce();
    expect(f.location.href).toBe("index.html");
    expect(f.notification.classList.add).not.toHaveBeenCalled();
  });

  it.each(["browser", "native"] as const)("shows a project error on %s without navigating away", async surface => {
    const f = await fixture(surface, {
      ok: false,
      error: { code: "invalid_package", message: "문해 프로젝트 폴더가 아닙니다." },
    });
    await f.cmd("open");

    expect(surface === "browser" ? f.fetcher : f.nativeOpen).toHaveBeenCalledOnce();
    expect(f.location.href).toBe("index.html");
    expect(f.title.textContent).toBe("프로젝트 열기");
    expect(f.message.textContent).toBe("문해 프로젝트 폴더가 아닙니다.");
    expect(f.notification.classList.add).toHaveBeenCalledWith("show");
  });

  it("does not bypass a pending authentication gate through the browser fallback", async () => {
    const f = await fixture("browser", { ok: true, data: project }, true);
    await f.cmd("open");

    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.nativeOpen).not.toHaveBeenCalled();
    expect(f.location.href).toBe("index.html");
  });
});
