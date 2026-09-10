import {
  AGENT_ADAPTER_DEFINITIONS,
  createAgentAdapter,
  type AgentAdapter,
  type AgentId,
  type AgentRunEvent,
  type AgentRunResult,
} from "@munhae/agent-runtime";
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  isAgentRuntimeRequest,
  type AgentRuntimeErrorPayload,
  type AgentRuntimeMessage,
  type AgentRuntimeRequest,
  type AgentRuntimeResult,
} from "./agent-runtime-protocol";

const adapters = Object.fromEntries(
  AGENT_ADAPTER_DEFINITIONS.map((definition) => [
    definition.id,
    createAgentAdapter(definition.id),
  ]),
) as Record<AgentId, AgentAdapter>;

type ActiveExecution = {
  adapter: AgentAdapter;
  completion: Promise<AgentRunResult>;
};

const active = new Map<string, ActiveExecution>();
const parentPort = process.parentPort;
let shuttingDown = false;

function post(message: AgentRuntimeMessage): void {
  parentPort.postMessage(message);
}

function safeError(error: unknown): AgentRuntimeErrorPayload {
  const rawCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "agent_runtime_failed";
  const code = /^[a-z0-9_-]{1,80}$/i.test(rawCode) ? rawCode : "agent_runtime_failed";
  const rawMessage = error instanceof Error ? error.message : "Agent runtime request failed";
  const message = rawMessage
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]")
    .replace(/((?:token|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .slice(0, 2_000);
  return { code, message: message || "Agent runtime request failed" };
}

function respond(requestId: string, value: AgentRuntimeResult): void {
  post({ type: "response", requestId, ok: true, value });
}

function reject(requestId: string, error: unknown): void {
  post({ type: "response", requestId, ok: false, error: safeError(error) });
}

function sinkFor(message: Extract<AgentRuntimeRequest, { operation: "run" | "resume" }>) {
  return (event: AgentRunEvent): void => {
    if (event.runId !== message.request.runId) return;
    post({
      type: "event",
      requestId: message.requestId,
      runId: message.request.runId,
      event,
    });
  };
}

async function executeRun(
  message: Extract<AgentRuntimeRequest, { operation: "run" | "resume" }>,
): Promise<void> {
  if (shuttingDown) throw Object.assign(new Error("Agent runtime is shutting down"), { code: "runtime_shutdown" });
  const runId = message.request.runId;
  if (active.has(runId)) {
    throw Object.assign(new Error(`Agent run ${runId} is already active`), { code: "run_already_active" });
  }
  const adapter = adapters[message.agentId];
  const completion = message.operation === "resume"
    ? adapter.resume(message.sessionRef, message.request, sinkFor(message))
    : adapter.run(message.request, sinkFor(message));
  active.set(runId, { adapter, completion });
  try {
    respond(message.requestId, await completion);
  } finally {
    active.delete(runId);
  }
}

async function dispatch(message: AgentRuntimeRequest): Promise<void> {
  switch (message.operation) {
    case "probe_all":
      respond(message.requestId, await Promise.all(
        AGENT_ADAPTER_DEFINITIONS.map((definition) => adapters[definition.id].probe()),
      ));
      return;
    case "probe":
      respond(message.requestId, await adapters[message.agentId].probe());
      return;
    case "begin_login":
      respond(message.requestId, await adapters[message.agentId].beginLogin());
      return;
    case "run":
    case "resume":
      await executeRun(message);
      return;
    case "cancel": {
      const execution = active.get(message.runId);
      if (execution) await execution.adapter.cancel(message.runId);
      respond(message.requestId, null);
      return;
    }
    case "shutdown": {
      shuttingDown = true;
      const executions = [...active.entries()];
      await Promise.allSettled(executions.map(([runId, execution]) => execution.adapter.cancel(runId)));
      await Promise.allSettled(executions.map(([, execution]) => execution.completion));
      respond(message.requestId, null);
      return;
    }
  }
}

parentPort.on("message", (event) => {
  if (!isAgentRuntimeRequest(event.data)) return;
  void dispatch(event.data).catch((error: unknown) => reject(event.data.requestId, error));
});

post({ type: "ready", protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION });
