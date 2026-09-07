import {
  app,
  utilityProcess,
  type UtilityProcess,
} from "electron";
import type {
  AgentEventSink,
  AgentId,
  AgentProbe,
  AgentRunRequest,
  AgentRunResult,
  LoginInstruction,
} from "@munhae/agent-runtime";
import { sanitizeEnv } from "@munhae/agent-runtime";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  isAgentRuntimeMessage,
  type AgentRuntimeMessage,
  type AgentRuntimeRequest,
  type AgentRuntimeResult,
} from "./agent-runtime-protocol";
import { log } from "./log";
import { mainDir } from "./paths";
import type { AgentLoginInstruction } from "../shared/munhae-api";

const READY_TIMEOUT_MS = 10_000;

type PendingRequest = {
  runId: string | null;
  sink: AgentEventSink | null;
  resolve: (value: AgentRuntimeResult) => void;
  reject: (error: Error) => void;
};

type AgentRuntimeRequestInput =
  | { operation: "probe_all" }
  | { operation: "probe"; agentId: AgentId }
  | { operation: "begin_login"; agentId: AgentId }
  | { operation: "run"; agentId: AgentId; request: AgentRunRequest }
  | { operation: "resume"; agentId: AgentId; sessionRef: string; request: AgentRunRequest }
  | { operation: "cancel"; runId: string }
  | { operation: "shutdown" };

class AgentRuntimeTransportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentRuntimeTransportError";
    this.code = code;
  }
}

class AgentRuntimeClient {
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();
  private closing = false;

  async probeAll(): Promise<AgentProbe[]> {
    return this.request<AgentProbe[]>({ operation: "probe_all" });
  }

  async probe(agentId: AgentId): Promise<AgentProbe> {
    return this.request<AgentProbe>({ operation: "probe", agentId });
  }

  async beginLogin(agentId: AgentId): Promise<LoginInstruction> {
    return this.request<LoginInstruction>({ operation: "begin_login", agentId });
  }

  async run(agentId: AgentId, request: AgentRunRequest, sink: AgentEventSink): Promise<AgentRunResult> {
    return this.request<AgentRunResult>({ operation: "run", agentId, request }, request.runId, sink);
  }

  async resume(
    agentId: AgentId,
    sessionRef: string,
    request: AgentRunRequest,
    sink: AgentEventSink,
  ): Promise<AgentRunResult> {
    return this.request<AgentRunResult>(
      { operation: "resume", agentId, sessionRef, request },
      request.runId,
      sink,
    );
  }

  async cancel(runId: string): Promise<void> {
    if (!this.child) return;
    await this.request<null>({ operation: "cancel", runId });
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.closing = true;
    try {
      await this.request<null>({ operation: "shutdown" });
    } catch (error) {
      log.warn("agent runtime shutdown failed", {
        code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
      });
    } finally {
      if (this.child === child) {
        child.kill();
        this.child = null;
        this.ready = null;
      }
      this.closing = false;
    }
  }

  private async request<T extends AgentRuntimeResult>(
    input: AgentRuntimeRequestInput,
    runId: string | null = null,
    sink: AgentEventSink | null = null,
  ): Promise<T> {
    const child = await this.ensureStarted();
    const requestId = randomUUID();
    const message = { type: "request", requestId, ...input } as AgentRuntimeRequest;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        runId,
        sink,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        child.postMessage(message);
      } catch (error) {
        this.pending.delete(requestId);
        reject(new AgentRuntimeTransportError(
          "runtime_transport_failed",
          error instanceof Error ? error.message : "Agent runtime request could not be sent",
        ));
      }
    });
  }

  private async ensureStarted(): Promise<UtilityProcess> {
    if (this.child && this.ready) {
      await this.ready;
      return this.child;
    }
    if (this.closing) {
      throw new AgentRuntimeTransportError("runtime_shutdown", "Agent runtime is shutting down");
    }
    const child = utilityProcess.fork(join(mainDir, "agent-runtime-worker.js"), [], {
      // An ASAR path can be loaded as a module, but it is not an OS directory
      // and therefore cannot be used as a child-process working directory.
      cwd: app.isPackaged ? process.resourcesPath : mainDir,
      env: sanitizeEnv(process.env),
      serviceName: "Munhae Agent Runtime",
      stdio: "ignore",
    });
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off("message", onReady);
        child.off("exit", onEarlyExit);
      };
      const onReady = (message: unknown): void => {
        if (!isAgentRuntimeMessage(message) || message.type !== "ready") return;
        cleanup();
        resolve();
      };
      const onEarlyExit = (code: number): void => {
        cleanup();
        reject(new AgentRuntimeTransportError(
          "runtime_exited",
          `Agent runtime exited before it was ready (code ${String(code)})`,
        ));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new AgentRuntimeTransportError("runtime_start_timeout", "Agent runtime did not become ready"));
        child.kill();
      }, READY_TIMEOUT_MS);
      child.on("message", onReady);
      child.once("exit", onEarlyExit);
    });
    child.on("message", (message: unknown) => this.onMessage(child, message));
    child.on("error", (type) => {
      log.warn("agent runtime process error", { type });
    });
    child.once("exit", (code) => this.onExit(child, code));
    try {
      await this.ready;
      return child;
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        this.ready = null;
      }
      throw error;
    }
  }

  private onMessage(child: UtilityProcess, value: unknown): void {
    if (child !== this.child || !isAgentRuntimeMessage(value) || value.type === "ready") return;
    const pending = this.pending.get(value.requestId);
    if (!pending) return;
    if (value.type === "event") {
      if (!pending.sink || pending.runId !== value.runId || value.event.runId !== value.runId) return;
      try {
        const emitted = pending.sink(value.event);
        if (emitted instanceof Promise) void emitted.catch(() => undefined);
      } catch {
        // A UI/event-log sink must not break the isolated provider run.
      }
      return;
    }
    this.pending.delete(value.requestId);
    if (value.ok) pending.resolve(value.value);
    else pending.reject(new AgentRuntimeTransportError(value.error.code, value.error.message));
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (child !== this.child) return;
    this.child = null;
    this.ready = null;
    const error = new AgentRuntimeTransportError(
      "runtime_exited",
      `Agent runtime exited unexpectedly (code ${String(code)})`,
    );
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const agentRuntime = new AgentRuntimeClient();

export const probeAllAgentRuntimes = (): Promise<AgentProbe[]> => agentRuntime.probeAll();
export const probeAgentRuntime = (agentId: AgentId): Promise<AgentProbe> => agentRuntime.probe(agentId);
export const getAgentLoginInstruction = async (agentId: AgentId): Promise<AgentLoginInstruction> => {
  const instruction = await agentRuntime.beginLogin(agentId);
  // Do not expose the resolved executable path or argv through renderer IPC.
  return {
    agentId: instruction.agentId,
    available: instruction.available,
    displayCommand: instruction.displayCommand,
    requiresInteractiveTerminal: true,
    detail: instruction.detail,
  };
};
export const runAgentRuntime = (
  agentId: AgentId,
  request: AgentRunRequest,
  sink: AgentEventSink,
): Promise<AgentRunResult> => agentRuntime.run(agentId, request, sink);
export const resumeAgentRuntime = (
  agentId: AgentId,
  sessionRef: string,
  request: AgentRunRequest,
  sink: AgentEventSink,
): Promise<AgentRunResult> => agentRuntime.resume(agentId, sessionRef, request, sink);
export const cancelAgentRuntime = (runId: string): Promise<void> => agentRuntime.cancel(runId);
export const shutdownAgentRuntime = (): Promise<void> => agentRuntime.shutdown();
