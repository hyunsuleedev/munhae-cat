import { type ProjectChangeEvent, projectChangePayload } from "../../shared/online-projects";
type Handler = (state: ProjectChangeEvent) => void;

// One stream per browser document, shared by the entry gate, account page and
// shared navigation. A transport failure never changes the last account state.
export function createBrowserProjectEvents(fetcher: typeof fetch = fetch) {
  const handlers = new Set<Handler>();
  let active: AbortController | null = null;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let latest: ProjectChangeEvent | null = null;
  let failures = 0;

  const notify = (state: ProjectChangeEvent) => {
    latest = state;
    for (const handler of [...handlers]) {
      try { handler(state); } catch { /* One view must not interrupt the others. */ }
    }
  };
  const connect = () => {
    if (active || reconnect !== undefined || handlers.size === 0) return;
    const controller = new AbortController();
    active = controller;
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetcher("/__munhae/project-events", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: "{}", signal: controller.signal, cache: "no-store",
        });
        if (!response.ok || !response.body) throw new Error("Account stream unavailable");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        while (active === controller && !controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let newline = pending.indexOf("\n");
          while (newline !== -1) {
            if (newline > 65536) throw new Error("Account event too large");
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (line) {
              const state = projectChangePayload(JSON.parse(line));
              if (!state) throw new Error("Invalid account event");
              if (active !== controller || controller.signal.aborted) return;
              failures = 0;
              notify(state);
            }
            newline = pending.indexOf("\n");
          }
          if (pending.length > 65536) throw new Error("Account event too large");
        }
      } catch { /* Preserve the current state and reconnect after a brief delay. */ }
      finally {
        void reader?.cancel().catch(() => undefined);
        if (active === controller) {
          active = null;
          if (handlers.size > 0) {
            const delay = Math.min(1_000 * 2 ** Math.min(failures++, 4), 10_000);
            reconnect = setTimeout(() => { reconnect = undefined; connect(); }, delay);
          }
        }
      }
    })();
  };
  const dispose = () => {
    handlers.clear();
    clearTimeout(reconnect);
    reconnect = undefined;
    const previous = active;
    active = null;
    previous?.abort();
    latest = null;
    failures = 0;
  };
  return {
    subscribe(handler: Handler): () => void {
      handlers.add(handler);
      const snapshot = latest;
      if (snapshot) queueMicrotask(() => {
        if (handlers.has(handler) && latest === snapshot) {
          try { handler(snapshot); } catch { /* Isolate subscribers. */ }
        }
      });
      connect();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) dispose();
      };
    },
    dispose,
  };
}
