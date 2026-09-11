import type { AccountState, MunhaeApi } from "../../shared/munhae-api";

const PAGES = new Set(["index.html", "home.html", "editor.html", "context.html", "knowledge.html", "settings.html"]);
const SETTINGS_SECTIONS = new Set(["account", "models", "skills", "general"]);

/** Only app-owned relative pages can be used after sign-in, including file:// builds. */
export function safeAccountReturn(value: string | null): string | null {
  if (!value || /[\\\r\n]/.test(value)) return null;
  const [route, section, extraSection] = value.split("#");
  const [page, query] = route!.split("?", 2);
  if (!page || !PAGES.has(page)) return null;
  if (section !== undefined && (page !== "settings.html" || !SETTINGS_SECTIONS.has(section) || extraSection !== undefined)) return null;
  const params = new URLSearchParams(query);
  const key = page === "editor.html" ? "doc" : page === "context.html" ? "node" : null;
  const id = key ? params.get(key) : null;
  return page + (key && id ? `?${key}=${encodeURIComponent(id)}` : "") + (section ? `#${section}` : "");
}

export function accountGateUrl(returnTo: string): string {
  return `account.html?next=${encodeURIComponent(safeAccountReturn(returnTo) ?? "index.html")}`;
}

type GateView = {
  load: () => Promise<unknown>;
  reveal: () => void;
  requireAccount: () => void;
  failed: (error: unknown) => void;
};

/** Main owns session restoration; pages consume its snapshot and subsequent events. */
export class AuthGate {
  private checking: Promise<void> | null = null;
  private loading: Promise<unknown> | null = null;
  private loaded = false;
  private blocked = false;
  private revision = 0;
  private disposed = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly auth: MunhaeApi["auth"], private readonly view: GateView) {}

  start(): Promise<void> {
    this.unsubscribe = this.auth.onStateChanged((state) => this.changed(state));
    return this.check();
  }

  private changed(state: AccountState): void {
    if (this.disposed) return;
    // A newer main-process event wins over an earlier snapshot request, in
    // either direction. Token refresh is a signed-in update, not a new gate.
    const revision = ++this.revision;
    void this.accept(state, revision).catch(error => this.fail(error, revision));
  }

  private async accept(state: AccountState, revision: number, revealLoaded = false): Promise<void> {
    if (this.disposed || revision !== this.revision) return;
    if (state.status !== "signed_in") {
      this.blocked = true;
      this.view.requireAccount();
      return;
    }
    if (this.loaded && !this.blocked) {
      if (revealLoaded) this.view.reveal();
      return;
    }
    if (!this.loaded) {
      // Events can arrive while a page imports and initializes. Share that
      // work so a refresh or restored connection never initializes it twice.
      this.loading ??= this.view.load().then(() => { this.loaded = true; })
        .finally(() => { this.loading = null; });
      await this.loading;
    }
    if (this.disposed || revision !== this.revision) return;
    this.blocked = false;
    this.view.reveal();
  }

  private fail(error: unknown, revision: number): void {
    if (this.disposed || revision !== this.revision) return;
    this.blocked = true;
    this.view.failed(error);
  }

  check(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.checking) return this.checking;
    const revision = this.revision;
    this.checking = (async () => {
      try {
        const result = await this.auth.getState();
        if (this.disposed || revision !== this.revision) return;
        if (!result.ok) throw new Error(result.error.message);
        await this.accept(result.data, revision, true);
      } catch (error) {
        this.fail(error, revision);
      }
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  dispose(): void { this.disposed = true; this.unsubscribe?.(); }
}
