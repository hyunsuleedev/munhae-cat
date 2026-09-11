export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "downloaded" | "installing" | "error";
export type UpdateState = { phase: UpdatePhase; version?: string; percent?: number };
export type UpdatePort = {
  check(): Promise<string | null>;
  download(): Promise<void>;
  install(): void;
};
export class UpdateController {
  state: UpdateState = { phase: "idle" };
  installRequested = false;
  constructor(private port: UpdatePort, private busy: () => boolean, private changed: (state: UpdateState) => void) {}
  private set(state: UpdateState) { this.state = state; this.changed(state); }
  async check(): Promise<void> {
    if (["checking", "downloading", "downloaded", "installing"].includes(this.state.phase)) return;
    this.set({ phase: "checking" });
    try {
      const version = await this.port.check();
      this.set(version ? { phase: "available", version } : { phase: "idle" });
    } catch (error) { this.set({ phase: "error" }); throw error; }
  }
  async download(): Promise<void> {
    if (this.state.phase !== "available") return;
    const version = this.state.version;
    this.set({ phase: "downloading", version, percent: 0 });
    try { await this.port.download(); this.set({ phase: "downloaded", version }); }
    catch (error) { this.set({ phase: "error" }); throw error; }
  }
  progress(percent: number) {
    if (this.state.phase === "downloading" && Number.isFinite(percent)) {
      this.set({ ...this.state, percent: Math.max(0, Math.min(100, percent)) });
    }
  }
  requestInstall(): boolean {
    if (this.state.phase !== "downloaded" || this.installRequested || this.busy()) return false;
    this.installRequested = true;
    return true;
  }
  canQuitForInstall(): boolean { return !this.installRequested || !this.busy(); }
  cancelInstall() { this.installRequested = false; }
  /** Call only after the renderer accepted leaving and application services closed. */
  finishQuit(): boolean {
    if (!this.installRequested || this.state.phase !== "downloaded") return false;
    this.installRequested = false;
    this.set({ ...this.state, phase: "installing" });
    this.port.install();
    return true;
  }
}
