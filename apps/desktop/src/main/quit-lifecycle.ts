type QuitEvent = { preventDefault(): void };

type QuitLifecycle = {
  prepare(): Promise<boolean>;
  shutdown(): Promise<void>;
  quit(): void;
  onError(error: unknown): void;
};

/** Keep live services intact until the renderer has accepted leaving its page. */
export function createQuitHandler(deps: QuitLifecycle): (event: QuitEvent) => Promise<void> {
  let phase: "idle" | "preparing" | "shutting-down" | "approved" = "idle";
  return async (event) => {
    if (phase === "approved") return;
    event.preventDefault();
    if (phase !== "idle") return;
    phase = "preparing";
    try {
      if (!(await deps.prepare())) {
        phase = "idle";
        return;
      }
      phase = "shutting-down";
      await deps.shutdown();
      phase = "approved";
      deps.quit();
    } catch (error) {
      phase = "idle";
      deps.onError(error);
    }
  };
}
