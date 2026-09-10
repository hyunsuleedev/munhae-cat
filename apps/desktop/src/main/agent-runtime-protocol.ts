import type {
  AgentId,
  AgentProbe,
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
  LoginInstruction,
} from "@munhae/agent-runtime";

export const AGENT_RUNTIME_PROTOCOL_VERSION = 1 as const;

type RequestBase = {
  type: "request";
  requestId: string;
};

export type AgentRuntimeRequest =
  | (RequestBase & { operation: "probe_all" })
  | (RequestBase & { operation: "probe"; agentId: AgentId })
  | (RequestBase & { operation: "begin_login"; agentId: AgentId })
  | (RequestBase & {
      operation: "run";
      agentId: AgentId;
      request: AgentRunRequest;
    })
  | (RequestBase & {
      operation: "resume";
      agentId: AgentId;
      sessionRef: string;
      request: AgentRunRequest;
    })
  | (RequestBase & { operation: "cancel"; runId: string })
  | (RequestBase & { operation: "shutdown" });

export type AgentRuntimeResult = AgentProbe[] | AgentProbe | LoginInstruction | AgentRunResult | null;

export type AgentRuntimeErrorPayload = {
  code: string;
  message: string;
};

export type AgentRuntimeMessage =
  | {
      type: "ready";
      protocolVersion: typeof AGENT_RUNTIME_PROTOCOL_VERSION;
    }
  | {
      type: "event";
      requestId: string;
      runId: string;
      event: AgentRunEvent;
    }
  | {
      type: "response";
      requestId: string;
      ok: true;
      value: AgentRuntimeResult;
    }
  | {
      type: "response";
      requestId: string;
      ok: false;
      error: AgentRuntimeErrorPayload;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAgentRuntimeRequest(value: unknown): value is AgentRuntimeRequest {
  if (!isRecord(value) || value.type !== "request" || typeof value.requestId !== "string") {
    return false;
  }
  switch (value.operation) {
    case "probe_all":
    case "shutdown":
      return true;
    case "probe":
    case "begin_login":
      return value.agentId === "codex" || value.agentId === "claude" || value.agentId === "antigravity";
    case "cancel":
      return typeof value.runId === "string";
    case "run":
      return (value.agentId === "codex" || value.agentId === "claude" || value.agentId === "antigravity")
        && isRecord(value.request)
        && typeof value.request.runId === "string"
        && typeof value.request.prompt === "string";
    case "resume":
      return (value.agentId === "codex" || value.agentId === "claude" || value.agentId === "antigravity")
        && typeof value.sessionRef === "string"
        && isRecord(value.request)
        && typeof value.request.runId === "string"
        && typeof value.request.prompt === "string";
    default:
      return false;
  }
}

export function isAgentRuntimeMessage(value: unknown): value is AgentRuntimeMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") {
    return value.protocolVersion === AGENT_RUNTIME_PROTOCOL_VERSION;
  }
  if (value.type === "event") {
    return typeof value.requestId === "string"
      && typeof value.runId === "string"
      && isRecord(value.event)
      && typeof value.event.type === "string"
      && typeof value.event.runId === "string";
  }
  if (value.type !== "response" || typeof value.requestId !== "string" || typeof value.ok !== "boolean") {
    return false;
  }
  return value.ok
    ? "value" in value
    : isRecord(value.error)
      && typeof value.error.code === "string"
      && typeof value.error.message === "string";
}
