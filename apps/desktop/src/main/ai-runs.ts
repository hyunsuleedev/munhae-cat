import { createAlignmentToolSession } from "./alignment-tool-session";
import { alignmentPreferences } from "../shared/alignment-preferences";
import { appendChatActivity } from "../shared/chat-activity";
import {
  containsSensitiveProviderData,
  sanitizeEnv,
  type AgentRunEvent,
  type AgentRunRequest,
} from "@munhae/agent-runtime";
import {
  sanitizeAgentEventForPersistence,
  type ProjectRepo,
} from "@munhae/db-sqlite";
import {
  TRANSLATION_ENVELOPE_CONTRACT,
} from "@munhae/domain";
import { join } from "node:path";
import {
  IPC_CHANNELS,
  type AiRunView,
  type AppConfig,
  type StartProjectChatInput,
  type StartPunctuationSuggestionInput,
  type StartTranslationInput,
} from "../shared/munhae-api";
import { AppError } from "./errors";
import {
  cancelAgentRuntime,
  probeAgentRuntime,
  resumeAgentRuntime,
  runAgentRuntime,
} from "./agent-runtime-client";
import { log } from "./log";
import {
  appendRunEventLine,
  closeRunEventLog,
  openRunEventLog,
  syncRunEventLog,
  type RunEventLog,
} from "./run-event-log";
import {
  createTranslationToolGrant,
  type TranslationToolGrant,
} from "./agent-tool-bridge";
import { mainDir } from "./paths";
import { getMainWindow } from "./window";

const MAX_PARTIAL_TEXT = 200_000;
const MAX_EVENTS_BYTES = 32_000_000;

type ActiveRun = {
  projectId: string;
  repo: ProjectRepo;
  events: string[];
  eventBytes: number;
  eventsTruncated: boolean;
  eventLog: RunEventLog;
  completion: Promise<void> | null;
  translationToolGrant: TranslationToolGrant | null;
  cancelRequested: boolean;
};

export type RuntimeSessionStore = {
  get(input: { providerKind: "codex" | "claude" | "antigravity"; projectId: string; threadId: string }): string | null;
  set(
    input: { providerKind: "codex" | "claude" | "antigravity"; projectId: string; threadId: string },
    providerSessionRef: string,
  ): void;
  clear(input: { providerKind: "codex" | "claude" | "antigravity"; projectId: string; threadId: string }): void;
};

const runs = new Map<string, AiRunView>();
const active = new Map<string, ActiveRun>();
const launches = new Set<{ projectId: string; canceled: boolean; completion: Promise<void> }>();
const persistenceHooks = new Set<(projectId: string) => void | Promise<void>>();
const launchPersistenceHooks = new Set<(projectId: string) => void | Promise<void>>();
const pendingPersistence = new Set<Promise<void>>();
let cancelingActivities = 0;

/** Terminal persistence runs after the event log and database result are complete. */
export function registerAiPersistenceHook(hook: (projectId: string) => void | Promise<void>, options: { beforeLaunch?: boolean } = {}): () => void {
  persistenceHooks.add(hook);
  if (options.beforeLaunch) launchPersistenceHooks.add(hook);
  return () => { persistenceHooks.delete(hook); launchPersistenceHooks.delete(hook); };
}

/** Provider execution must not start before an online reservation/input is accepted. */
export async function persistAiBeforeLaunch(projectId: string): Promise<void> {
  for (const hook of launchPersistenceHooks) await hook(projectId);
}

async function persistReservedRunBeforeLaunch(repo: ProjectRepo, assertNotCanceled: () => void,
  failRun: (failure: { code: string; message: string }) => void): Promise<void> {
  try { await persistAiBeforeLaunch(repo.projectId); assertNotCanceled(); }
  catch (error) {
    const canceled = error instanceof AppError && error.code === "canceled";
    try { failRun({ code: canceled ? "canceled" : "online_persistence_failed",
      message: canceled ? "AI 실행 준비를 취소했습니다." : "온라인 저장을 확인하지 못해 AI를 실행하지 않았습니다. 다시 저장한 뒤 실행하세요." }); }
    catch { log.warn("AI launch failure remains pending in local recovery", { projectId: repo.projectId }); }
    await persistAiCompletion(repo.projectId);
    throw error;
  }
}

function persistAiCompletion(projectId: string): Promise<void> {
  const completion = Promise.resolve().then(async () => {
    for (const hook of persistenceHooks) {
      try { await hook(projectId); }
      catch { log.warn("AI result persistence pending", { projectId }); }
    }
  }).finally(() => { pendingPersistence.delete(completion); });
  pendingPersistence.add(completion);
  return completion;
}

async function finishRun(messageId: string, entry: ActiveRun): Promise<void> {
  try { closeRunEventLog(entry.eventLog); }
  finally {
    active.delete(messageId);
    await persistAiCompletion(entry.projectId);
  }
}

async function withAiLaunch<T>(projectId: string, launch: (assertNotCanceled: () => void) => Promise<T>): Promise<T> {
  if (cancelingActivities || hasActiveAiRuns(projectId)) throw new AppError("thread_busy", "AI 작업이 진행 중입니다");
  let finish!: () => void;
  const reservation = { projectId, canceled: false, completion: new Promise<void>((resolve) => { finish = resolve; }) };
  launches.add(reservation);
  try {
    return await launch(() => {
      if (reservation.canceled) throw new AppError("canceled", "AI 실행 준비를 취소했습니다.");
    });
  } finally {
    launches.delete(reservation);
    finish();
  }
}

type ExternalAiActivity = { id: string; projectId: string; cancel(): void | Promise<void>; completion: Promise<void> };
const externalActivities = new Map<string, ExternalAiActivity>();

/** Reserve before the first await so collection and inference share app lifecycle guards. */
export function registerExternalAiActivity(activity: ExternalAiActivity): void {
  if (cancelingActivities || hasActiveAiRuns(activity.projectId) || externalActivities.has(activity.id)) {
    throw new AppError("thread_busy", "AI 작업이 진행 중입니다");
  }
  const finish = async () => {
    if (externalActivities.get(activity.id) === registered) externalActivities.delete(activity.id);
    await persistAiCompletion(activity.projectId);
  };
  const registered = { ...activity, completion: activity.completion.then(finish, finish) };
  externalActivities.set(activity.id, registered);
}

function readRuntimeSessionRef(
  sessionStore: RuntimeSessionStore,
  key: Parameters<RuntimeSessionStore["get"]>[0],
): string | null {
  try {
    return sessionStore.get(key);
  } catch {
    log.warn("agent session reference could not be read", {
      providerKind: key.providerKind,
      projectId: key.projectId,
      threadId: key.threadId,
    });
    return null;
  }
}

function cloneRun(run: AiRunView): AiRunView {
  return {
    ...run,
    error: run.error ? { ...run.error } : null,
  };
}

function publish(run: AiRunView, completionStage?: AiRunView["completionStage"]): void {
  runs.set(run.messageId, run);
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.aiRunEvent, { ...cloneRun(run), completionStage });
}

function appendEvent(entry: ActiveRun, event: AgentRunEvent): void {
  const safeEvent = sanitizeAgentEventForPersistence(event);
  if (!safeEvent) return;
  const line = `${JSON.stringify(safeEvent)}\n`;
  const bytes = Buffer.byteLength(line, "utf8");
  if (entry.eventBytes + bytes <= MAX_EVENTS_BYTES) {
    entry.events.push(line);
    entry.eventBytes += bytes;
    try {
      appendRunEventLine(entry.eventLog, line);
    } catch {
      // The in-memory copy can still be attached to the terminal message.
    }
    return;
  }
  if (!entry.eventsTruncated) {
    const safeWarning = sanitizeAgentEventForPersistence({
      type: "warning",
      runId: event.runId,
      agentId: event.agentId,
      at: new Date().toISOString(),
      code: "event_log_truncated",
    });
    if (!safeWarning) return;
    const warning = `${JSON.stringify(safeWarning)}\n`;
    entry.events.push(warning);
    entry.eventBytes += Buffer.byteLength(warning, "utf8");
    entry.eventsTruncated = true;
    try {
      appendRunEventLine(entry.eventLog, warning);
    } catch {
      // Keep the in-memory copy.
    }
  }
}

function collectedEvents(entry: ActiveRun): string {
  try {
    syncRunEventLog(entry.eventLog);
  } catch {
    // The in-memory copy is authoritative for attaching the terminal event log.
  }
  return entry.events.join("");
}

function modelArg(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "default" ? undefined : trimmed;
}

function reasoningArg(value: string | null): AgentRunRequest["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

function serviceTierArg(value: string | null): AgentRunRequest["serviceTier"] {
  return value === "auto" || value === "default" || value === "flex" || value === "priority"
    ? value
    : undefined;
}

const PUBLIC_RUN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  app_submission_missing: "AI가 완성 번역을 앱에 제출하지 않았습니다.",
  app_submission_repeated: "AI 응답이 필요한 제출 형식을 충족하지 않았습니다.",
  invalid_json: "AI 응답이 필요한 제출 형식을 충족하지 않았습니다.",
  invalid_payload: "AI 응답이 필요한 제출 형식을 충족하지 않았습니다.",
  invalid_envelope: "AI 응답이 필요한 제출 형식을 충족하지 않았습니다.",
  submission_rejected: "AI가 제출한 결과를 현재 작업안에 적용할 수 없습니다.",
  cli_not_found: "선택한 AI CLI를 찾을 수 없습니다.",
  auth_required: "선택한 AI CLI 로그인이 필요합니다.",
  auth_unknown: "AI CLI 로그인 상태를 확인할 수 없습니다.",
  context_too_large: "AI 요청이 현재 모델의 문맥 한도를 넘었습니다.",
  rate_limited: "AI 서비스 사용량 제한에 도달했습니다. 잠시 후 다시 시도하세요.",
  upstream_unavailable: "AI 서비스가 일시적으로 응답하지 않습니다.",
  connection_dropped: "AI 서비스 연결이 중단되었습니다.",
  session_unavailable: "기존 AI 대화를 이어갈 수 없습니다. 새 대화로 다시 시도하세요.",
  canceled: "AI 실행을 취소했습니다.",
  timeout: "AI 실행 시간이 초과되었습니다.",
  invalid_stream: "AI 응답 스트림을 처리하지 못했습니다.",
  tool_permission_required: "AI가 요청한 도구의 실행 권한이 없어 중단됐습니다. 터미널에서 해당 CLI의 도구 권한을 설정한 뒤 다시 시도하세요.",
  provider_failed: "AI CLI 실행에 실패했습니다.",
  event_log_unavailable: "AI 실행 기록을 안전하게 만들 수 없습니다.",
  runtime_transport_failed: "AI 실행 프로세스와 통신하지 못했습니다.",
  runtime_exited: "AI 실행 프로세스가 예기치 않게 종료되었습니다.",
  runtime_start_timeout: "AI 실행 프로세스를 시작하지 못했습니다.",
  runtime_shutdown: "AI 실행 프로세스가 종료 중입니다.",
  run_already_active: "같은 AI 실행이 이미 진행 중입니다.",
  stale_request: "AI 실행 중 작업 내용이 바뀌어 결과를 적용하지 않았습니다.",
  cas_conflict: "AI 실행 중 작업 내용이 바뀌어 결과를 적용하지 않았습니다.",
  request_hash_mismatch: "저장된 AI 요청을 안전하게 확인하지 못했습니다.",
  invalid_request_manifest: "저장된 AI 요청을 안전하게 확인하지 못했습니다.",
  invalid_message: "AI 실행 기록을 안전하게 확인하지 못했습니다.",
  invalid_message_state: "AI 실행 상태가 바뀌어 결과를 적용하지 않았습니다.",
  apply_failed: "AI 실행 결과를 안전하게 적용하지 못했습니다.",
  internal: "AI 실행 결과를 안전하게 처리하지 못했습니다.",
};

/**
 * Provider messages can contain stderr, local paths, command text, session
 * references, or tool output. Only the stable application-owned code crosses
 * into the renderer; the provider-authored message is never a UI fallback.
 */
export function publicRunError(error: { code: string; message: string }): { code: string; message: string } {
  const message = PUBLIC_RUN_ERROR_MESSAGES[error.code];
  if (!message) {
    return {
      code: "provider_failed",
      message: PUBLIC_RUN_ERROR_MESSAGES.provider_failed ?? "AI CLI 실행에 실패했습니다.",
    };
  }
  return {
    code: error.code,
    message,
  };
}

export function updateFromEvent(view: AiRunView, event: AgentRunEvent): void {
  if (view.taskKind === "chat" || (view.taskKind === "translation" && (event.type === "thinking_delta" || event.type === "tool_call"))) {
    appendChatActivity(view.activity ??= [], event, view.agentId);
  }
  if (event.type === "status") {
    view.phase = event.phase;
    view.detail = {
      starting: "AI 실행을 준비하고 있습니다…",
      initializing: "AI 연결을 준비하고 있습니다…",
      thinking: "AI 응답을 기다리고 있습니다. 긴 작업은 시간이 더 걸릴 수 있습니다.",
      streaming: "AI 응답을 받고 있습니다…",
      stopping: "AI 실행을 취소하고 있습니다…",
    }[event.phase];
  } else if (event.type === "text_delta") {
    view.phase = "streaming";
    if (view.taskKind !== "chat") {
      // Structured tasks are exposed only after their app-level validation.
      // Provider prose before that boundary is an interim activity stream, not
      // a preview, so it must never cross into the renderer view.
      view.partialText = "";
      view.detail = "응답 처리 중…";
    } else {
      view.partialText = `${view.partialText}${event.text}`.slice(-MAX_PARTIAL_TEXT);
    }
  } else if (event.type === "thinking_delta") {
    view.phase = "thinking";
    if ((view.taskKind === "chat" || view.taskKind === "translation") && (view.agentId === "codex" || view.agentId === "claude")) {
      view.thinkingText = `${view.thinkingText ?? ""}${event.text}`.slice(0, MAX_PARTIAL_TEXT);
    }
  } else if (event.type === "tool_call") {
    view.phase = "validating";
    view.detail = event.state === "failed" ? "응답 처리에 실패했습니다." : "응답 처리 중…";
  } else if (event.type === "warning") {
    view.detail = "에이전트 응답을 확인하고 있습니다.";
  } else if (event.type === "error") {
    view.detail = publicRunError(event.error).message;
  }
}

export function requestFromPreferences(
  runId: string,
  prompt: string,
  config: AppConfig,
  agentId: "codex" | "claude" | "antigravity",
): AgentRunRequest {
  const prefs = config.agentModels[agentId];
  return {
    runId,
    prompt,
    ...(modelArg(prefs.model) ? { model: modelArg(prefs.model) } : {}),
    ...(reasoningArg(prefs.reasoning) ? { reasoningEffort: reasoningArg(prefs.reasoning) } : {}),
    ...(agentId === "codex" && serviceTierArg(prefs.serviceTier)
      ? { serviceTier: serviceTierArg(prefs.serviceTier) }
      : {}),
  };
}

async function executeProjectTask(
  prepared: ReturnType<ProjectRepo["beginProjectChatRun"]> | ReturnType<ProjectRepo["beginPunctuationSuggestionRun"]>,
  view: AiRunView,
  entry: ActiveRun,
  config: AppConfig,
  sessionStore: RuntimeSessionStore,
): Promise<void> {
  const request = requestFromPreferences(prepared.messageId, prepared.requestText, config, view.agentId);
  request.streamText = view.taskKind === "chat";
  if (view.agentId === "antigravity" && view.taskKind === "punctuation_suggest") {
    request.antigravitySkipPermissions = true;
  }
  const sessionKey = {
    providerKind: view.agentId,
    projectId: entry.projectId,
    threadId: prepared.threadId,
  } as const;
  const resumeRef = view.taskKind === "chat" && prepared.resumeCompatible
    ? readRuntimeSessionRef(sessionStore, sessionKey)
    : null;
  try {
    if (entry.cancelRequested) throw new AppError("canceled", "AI 실행이 취소되었습니다.");
    const sink = (event: AgentRunEvent): void => {
      appendEvent(entry, event);
      updateFromEvent(view, event);
      publish(view);
    };
    const result = resumeRef
      ? await resumeAgentRuntime(view.agentId, resumeRef, request, sink)
      : await runAgentRuntime(view.agentId, request, sink);
    if (!result.ok) {
      appendEvent(entry, {
        type: "error",
        runId: prepared.messageId,
        agentId: view.agentId,
        at: result.completedAt,
        error: result.error,
      });
      if (resumeRef && result.error.code === "session_unavailable") {
        try {
          sessionStore.clear(sessionKey);
        } catch {
          log.warn("unavailable agent session reference could not be cleared", {
            messageId: prepared.messageId,
            agentId: view.agentId,
          });
        }
        entry.repo.invalidateProjectAgentSession({ threadId: prepared.threadId, agentId: view.agentId });
      }
      const publicError = publicRunError(result.error);
      entry.repo.failProjectTaskRun(prepared.messageId, publicError, {
        eventsJsonl: collectedEvents(entry),
        usage: result.usage,
        resolvedModel: result.model,
        runtimeVersion: result.cliVersion,
      });
      view.state = result.error.code === "canceled" ? "canceled" : "failed";
      view.phase = view.state;
      view.detail = result.error.code === "context_too_large"
        ? "문서·장·편의 실제 경계에서 원문을 나눈 뒤 다시 실행하세요."
        : publicError.message;
      view.error = publicError;
      view.completedAt = result.completedAt;
      publish(view);
      return;
    }

    const rawResponse = result.outputText;
    if (view.taskKind === "chat" || !view.partialText) view.partialText = rawResponse.slice(-MAX_PARTIAL_TEXT);
    if (view.taskKind === "chat") {
      entry.repo.completeProjectChatRun({
        messageId: prepared.messageId,
        rawResponse,
        eventsJsonl: collectedEvents(entry),
        usage: result.usage,
        resolvedModel: result.model,
        runtimeVersion: result.cliVersion,
      });
      if (result.sessionRef) {
        try {
          entry.repo.recordProjectAgentSession({
            messageId: prepared.messageId,
            threadId: prepared.threadId,
            agentId: view.agentId,
            requestedModel: prepared.requestedModel,
            stablePromptHash: prepared.stablePromptHash,
          });
          sessionStore.set(sessionKey, result.sessionRef);
        } catch {
          // The response is already durably complete. Session persistence is
          // optional acceleration and must never turn success into failure.
          log.warn("project chat session reference was not recorded", {
            messageId: prepared.messageId,
            agentId: view.agentId,
          });
        }
      }
      view.validationState = null;
      view.detail = resumeRef ? "기존 CLI 대화를 이어 답변을 저장했습니다." : "프로젝트 채팅 답변을 저장했습니다.";
    } else {
      const completed = entry.repo.completePunctuationSuggestionRun({
        messageId: prepared.messageId,
        rawResponse,
        eventsJsonl: collectedEvents(entry),
        usage: result.usage,
        resolvedModel: result.model,
        runtimeVersion: result.cliVersion,
      });
      view.validationState = completed.validationState;
      view.detail = completed.validationState === "valid"
        ? "원문 보존과 표점 형식을 확인해 미적용 제안으로 저장했습니다. 표점 해석은 화면에서 검토한 뒤 적용하세요."
        : "AI 응답은 보존했지만 원문 보존 또는 표점 형식 검사에 실패해 표점안에는 적용하지 않았습니다.";
    }
    view.state = "completed";
    view.phase = view.validationState === "invalid_unapplied" ? "validation_failed" : "completed";
    view.completedAt = result.completedAt;
    publish(view, view.phase === "completed" ? (view.taskKind === "chat" ? "chat" : "punctuation") : undefined);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "internal";
    const message = error instanceof Error ? error.message : "AI 실행 결과를 저장하지 못했습니다.";
    const publicError = publicRunError({ code, message });
    try {
      entry.repo.failProjectTaskRun(prepared.messageId, publicError, {
        eventsJsonl: collectedEvents(entry),
      });
    } catch {
      // A terminal message must not be overwritten by a late transport error.
    }
    view.state = code === "canceled" ? "canceled" : "failed";
    view.phase = view.state;
    view.detail = publicError.message;
    view.error = publicError;
    view.completedAt = new Date().toISOString();
    publish(view);
    log.warn("AI project task failed", {
      messageId: prepared.messageId,
      agentId: view.agentId,
      taskKind: view.taskKind,
      code,
    });
  } finally {
    await finishRun(prepared.messageId, entry);
  }
}

async function requireAvailableAgent(agentId: "codex" | "claude" | "antigravity") {
  const probe = await probeAgentRuntime(agentId);
  if (!probe.installed) throw new AppError("cli_not_found", `${agentId} CLI가 설치되어 있지 않습니다.`);
  if (probe.loggedIn === false) throw new AppError("auth_required", `${agentId} CLI 로그인이 필요합니다.`);
  if (probe.loggedIn === null && probe.agentId !== "antigravity") throw new AppError("auth_unknown", `${agentId} CLI 로그인 상태를 확인할 수 없습니다.`);
  return probe;
}

function createRunEntry(
  repo: ProjectRepo,
  messageId: string,
  onFailure: (error: { code: string; message: string }) => void,
): ActiveRun {
  let eventLog: RunEventLog;
  try {
    eventLog = openRunEventLog(repo.packagePath, messageId);
  } catch (error) {
    onFailure({ code: "event_log_unavailable", message: "AI 실행 event 기록 파일을 만들 수 없습니다" });
    throw new AppError(
      "event_log_unavailable",
      error instanceof Error ? error.message : "AI 실행 event 기록 파일을 만들 수 없습니다.",
    );
  }
  return {
    projectId: repo.projectId,
    repo,
    events: [],
    eventBytes: 0,
    eventsTruncated: false,
    eventLog,
    completion: null,
    translationToolGrant: null,
    cancelRequested: false,
  };
}

function initialRunView(input: {
  messageId: string;
  documentNodeId: string;
  chatScopeKind?: AiRunView["chatScopeKind"];
  agentId: "codex" | "claude" | "antigravity";
  taskKind: AiRunView["taskKind"];
  detail: string;
}): AiRunView {
  return {
    ...input,
    state: "running",
    phase: "starting",
    partialText: "",
    error: null,
    validationState: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
  };
}

async function executePrepared(
  prepared: ReturnType<ProjectRepo["beginTranslationRun"]>,
  view: AiRunView,
  entry: ActiveRun,
  config: AppConfig,
  sessionStore: RuntimeSessionStore,
): Promise<void> {
  const prefs = config.agentModels[view.agentId];
  let grant: TranslationToolGrant | null = null;
  const submissionState: {
    completion: ReturnType<ProjectRepo["completeTranslationRun"]> | null;
    sensitivePayloadRejected: boolean;
  } = { completion: null, sensitivePayloadRejected: false };
  const inheritedProviderEnv = sanitizeEnv(process.env);
  try {
    grant = await createTranslationToolGrant({
      projectId: entry.projectId,
      runId: prepared.messageId,
      onSubmit(rawBody) {
        const grantToken = grant?.token;
        if (
          !grantToken
          || containsSensitiveProviderData(rawBody, inheritedProviderEnv, [grantToken])
        ) {
          submissionState.sensitivePayloadRejected = true;
          throw new AppError("submission_rejected", "AI 제출에 저장할 수 없는 민감 정보가 포함되어 있습니다.");
        }
        const completed = entry.repo.completeTranslationRun({
          messageId: prepared.messageId,
          rawResponse: rawBody,
          eventsJsonl: collectedEvents(entry),
          usage: null,
          resolvedModel: null,
          runtimeVersion: null,
        });
        submissionState.completion = completed;
        if (completed.validationState !== "valid") {
          throw new AppError("invalid_envelope", "AI가 제출한 번역 구조가 올바르지 않습니다.");
        }
      },
    });
    entry.translationToolGrant = grant;
    if (entry.cancelRequested) throw new AppError("canceled", "AI 번역 실행이 취소되었습니다.");

    const wrapperPath = join(mainDir, "agent-tool-cli.js");
    const request: AgentRunRequest = {
      runId: prepared.messageId,
      prompt: prepared.requestText,
      outputContract: TRANSLATION_ENVELOPE_CONTRACT,
      appTool: {
        command: process.execPath,
        args: [wrapperPath, "tools", "submit-translation"],
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          MUNHAE_NODE_BIN: process.execPath,
          MUNHAE_BIN: wrapperPath,
          MUNHAE_TOOL_URL: grant.endpoint,
          MUNHAE_TOOL_GRANT: grant.token,
          MUNHAE_TOOL_RUN_ID: prepared.messageId,
        },
      },
      ...(modelArg(prefs.model) ? { model: modelArg(prefs.model) } : {}),
      ...(reasoningArg(prefs.reasoning) ? { reasoningEffort: reasoningArg(prefs.reasoning) } : {}),
      ...(view.agentId === "codex" && serviceTierArg(prefs.serviceTier)
        ? { serviceTier: serviceTierArg(prefs.serviceTier) }
        : {}),
    };
    const result = await runAgentRuntime(view.agentId, request, (event) => {
      appendEvent(entry, event);
      updateFromEvent(view, event);
      publish(view);
    });
    const submission = grant.inspect();
    const acceptedSubmission = submission.committed
      && submission.rawBody !== null
      && submissionState.completion?.validationState === "valid";

    // The app-owned callback commits the run-bound domain transaction before
    // the bridge returns 2xx. Provider display text is never a submission path.
    if (acceptedSubmission) {
      let completed = submissionState.completion!;
      try {
        completed = entry.repo.completeTranslationRun({
          messageId: prepared.messageId,
          rawResponse: submission.rawBody!,
          eventsJsonl: collectedEvents(entry),
          usage: result.usage,
          resolvedModel: result.model,
          runtimeVersion: result.cliVersion,
        });
      } catch {
        // The translation commit is already authoritative. A late provenance
        // enrichment failure must not turn the durable draft into a failed run.
        log.warn("committed translation metadata could not be finalized", {
          messageId: prepared.messageId,
          agentId: view.agentId,
        });
      }
      if (result.ok && result.sessionRef) {
        try {
          entry.repo.recordTranslationAgentSession({
            messageId: prepared.messageId,
            threadId: prepared.threadId,
            agentId: view.agentId,
            model: result.model,
            stablePromptHash: prepared.requestHash,
          });
          sessionStore.set({
            providerKind: view.agentId,
            projectId: entry.projectId,
            threadId: prepared.threadId,
          }, result.sessionRef);
        } catch {
          log.warn("agent session reference was not recorded", {
            messageId: prepared.messageId,
            agentId: view.agentId,
          });
        }
      }
      view.partialText = "";
      view.state = "completed";
      view.phase = completed.validationState === "valid" ? "completed" : "validation_failed";
      view.detail = completed.validationState === "valid"
        ? "완성된 번역을 작업안으로 저장했습니다."
        : `응답 구조 오류 ${completed.fatalFindings + completed.recoverableFindings}건으로 번역은 적용하지 않고 제출 응답만 보존했습니다.`;
      view.validationState = completed.validationState;
      view.completedAt = result.completedAt;
      publish(view, completed.validationState === "valid" ? "translation" : undefined);
      return;
    }

    if (submission.callCount > 0) {
      // Invalid JSON and non-object JSON are rejected by the bridge before its
      // repository callback. Re-check their raw bytes here so that parser-level
      // rejection can never route a credential-bearing body into an artifact.
      const sensitivePayloadRejected = submission.rawBody !== null && (
        submissionState.sensitivePayloadRejected
        || !grant
        || containsSensitiveProviderData(submission.rawBody, inheritedProviderEnv, [grant.token])
      );
      if (sensitivePayloadRejected) submissionState.sensitivePayloadRejected = true;
      const code = sensitivePayloadRejected
        ? "submission_rejected"
        : submission.callCount !== 1
          ? "app_submission_repeated"
          : submission.error ?? "invalid_payload";
      const message = sensitivePayloadRejected
        ? "AI가 제출한 번역을 현재 작업안에 적용할 수 없습니다."
        : submission.callCount !== 1
          ? "AI가 한 실행에서 번역을 두 번 이상 제출했습니다."
          : submission.error === "submission_rejected"
            ? "AI가 제출한 번역을 현재 작업안에 적용할 수 없습니다."
            : "AI가 제출한 번역 JSON을 해석할 수 없습니다.";
      if (submission.rawBody !== null && !sensitivePayloadRejected) {
        entry.repo.recordInvalidTranslationResponse({
          messageId: prepared.messageId,
          rawResponse: submission.rawBody,
          eventsJsonl: collectedEvents(entry),
          usage: result.usage,
          resolvedModel: result.model,
          runtimeVersion: result.cliVersion,
          error: { code, message },
        });
      } else {
        entry.repo.failTranslationRun(prepared.messageId, { code, message }, {
          eventsJsonl: collectedEvents(entry),
          usage: result.usage,
          resolvedModel: result.model,
          runtimeVersion: result.cliVersion,
        });
      }
      view.partialText = "";
      const repositoryRejected = sensitivePayloadRejected || (
        submission.error === "submission_rejected" && submissionState.completion === null
      );
      view.state = repositoryRejected ? "failed" : "completed";
      view.phase = repositoryRejected ? "failed" : "validation_failed";
      view.detail = repositoryRejected
        ? "AI가 제출한 번역을 현재 작업안에 적용하지 못했습니다."
        : "AI 응답이 필요한 제출 형식을 충족하지 않아 번역안에는 적용하지 않았습니다.";
      view.error = publicRunError({ code, message });
      view.validationState = repositoryRejected ? null : "invalid_unapplied";
      view.completedAt = result.completedAt;
      publish(view);
      return;
    }

    if (result.ok) {
      const error = {
        code: "app_submission_missing",
        message: "AI가 완성 번역을 앱에 제출하지 않았습니다.",
      };
      entry.repo.failTranslationRun(prepared.messageId, error, {
        eventsJsonl: collectedEvents(entry),
        usage: result.usage,
        resolvedModel: result.model,
        runtimeVersion: result.cliVersion,
      });
      view.partialText = "";
      view.state = "failed";
      view.phase = "validation_failed";
      view.detail = "AI가 완성 번역을 앱에 제출하지 않았습니다.";
      view.error = publicRunError(error);
      view.validationState = "invalid_unapplied";
      view.completedAt = result.completedAt;
      publish(view);
      return;
    }

    if (!result.ok) {
      appendEvent(entry, {
        type: "error",
        runId: prepared.messageId,
        agentId: view.agentId,
        at: result.completedAt,
        error: result.error,
      });
      const publicError = publicRunError(result.error);
      entry.repo.failTranslationRun(prepared.messageId, publicError, {
        eventsJsonl: collectedEvents(entry),
        usage: result.usage,
        resolvedModel: result.model,
        runtimeVersion: result.cliVersion,
      });
      view.state = result.error.code === "canceled" ? "canceled" : "failed";
      view.phase = view.state;
      view.detail = result.error.code === "context_too_large"
        ? "문서·장·편의 실제 경계에서 원문을 나눈 뒤 다시 실행하세요."
        : publicError.message;
      view.error = publicError;
      view.completedAt = result.completedAt;
      publish(view);
      return;
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "internal";
    const message = error instanceof Error ? error.message : "AI 번역 결과를 저장하지 못했습니다.";
    const publicError = publicRunError({ code, message });
    try {
      entry.repo.failTranslationRun(prepared.messageId, publicError, {
        eventsJsonl: collectedEvents(entry),
      });
    } catch {
      // A concurrent successful completion is terminal and must not be overwritten.
    }
    view.state = code === "canceled" ? "canceled" : "failed";
    view.phase = view.state;
    view.detail = publicError.message;
    view.error = publicError;
    view.completedAt = new Date().toISOString();
    publish(view);
    log.warn("AI translation run failed", { messageId: prepared.messageId, agentId: view.agentId, code });
  } finally {
    grant?.revoke();
    entry.translationToolGrant = null;
    await finishRun(prepared.messageId, entry);
  }
}

async function executeFullText(
  prepared: ReturnType<ProjectRepo["beginFullTextRun"]>,
  view: AiRunView, entry: ActiveRun, config: AppConfig, alignmentVersionId?: string,
): Promise<void> {
  let versionId: string | null = alignmentVersionId ?? null;
  const translationAgent = view.agentId;
  const providerEnv = sanitizeEnv(process.env);
  let savedResponse: string | null = null;
  let alignmentNeedsReview = false;
  let firstResult: Awaited<ReturnType<typeof runAgentRuntime>> | null = null;
  const wrapperPath = join(mainDir, "agent-tool-cli.js");
  const execute = async (prompt: string, phase: "translation" | "alignment", accept?: (raw: string) => void) => {
    const stagePrefs = phase === "alignment" ? alignmentPreferences(config, translationAgent) : { agentId: translationAgent, ...config.agentModels[translationAgent] };
    const { agentId: stageAgent, ...prefs } = stagePrefs;
    view.agentId = stageAgent;
    let grant: TranslationToolGrant | null = null;
    try {
      if (phase === "alignment") {
        const probe = await probeAgentRuntime(stageAgent);
        if (!probe.installed) throw new AppError("cli_not_found", `${stageAgent} CLI가 설치되어 있지 않습니다.`);
        if (probe.loggedIn === false) throw new AppError("auth_required", `${stageAgent} CLI 로그인이 필요합니다.`);
        if (probe.loggedIn === null && stageAgent !== "antigravity") throw new AppError("auth_unknown", `${stageAgent} CLI 로그인 상태를 확인할 수 없습니다.`);
        await persistAiBeforeLaunch(entry.projectId);
        if (entry.cancelRequested) throw new AppError("canceled", "실행을 취소했습니다");
      }
      const alignmentTools = phase === "alignment" ? createAlignmentToolSession(entry.repo, versionId!) : null;
      grant = await createTranslationToolGrant({ projectId:entry.projectId, runId:prepared.messageId,
        ...(alignmentTools ? { onAlignment(command, raw) {
          if (entry.cancelRequested || !grant || containsSensitiveProviderData(raw, providerEnv, [grant.token])) return { ok: false, error: "submission_rejected" };
          const result = alignmentTools(command, raw);
          if (result.ok && command === "submit-alignment") publish(view, "alignment");
          if (result.ok && command === "finish-alignment") {
            alignmentNeedsReview = result.state === "needs_review";
            if (alignmentVersionId) savedResponse = grant.inspect().rawBody ?? raw;
          }
          return result;
        } } : {}),
        onSubmit(raw) {
          if(entry.cancelRequested) throw new AppError("canceled", "실행을 취소했습니다");
          if(!grant || containsSensitiveProviderData(raw, providerEnv, [grant.token])) throw new AppError("submission_rejected", "저장할 수 없는 제출입니다");
          if (!accept) throw new AppError("submission_rejected", "이 실행은 연결 도구만 사용할 수 있습니다");
          accept(raw);
        },
      });
      entry.translationToolGrant=grant;
      if(entry.cancelRequested) throw new AppError("canceled", "실행을 취소했습니다");
      const command = phase === "translation" ? "submit-translation" : "submit-alignment";
      const request: AgentRunRequest = {
        runId:prepared.messageId, prompt, outputContract:phase === "translation" ? "translation-text.v1" : prompt.includes("## Alignment mode\nboundary-groups.v3") ? "translation-alignment.v3" : "translation-alignment.v1",
        appTool:{command:process.execPath,args:[wrapperPath,"tools",command],env:{
          ELECTRON_RUN_AS_NODE:"1",MUNHAE_NODE_BIN:process.execPath,MUNHAE_BIN:wrapperPath,
          MUNHAE_TOOL_URL:grant.endpoint,MUNHAE_TOOL_GRANT:grant.token,MUNHAE_TOOL_RUN_ID:prepared.messageId,
          MUNHAE_TOOL_COMMAND:command,
        }},
        ...(modelArg(prefs.model)?{model:modelArg(prefs.model)}:{}),
        ...(reasoningArg(prefs.reasoning)?{reasoningEffort:reasoningArg(prefs.reasoning)}:{}),
        ...(view.agentId==="codex"&&serviceTierArg(prefs.serviceTier)?{serviceTier:serviceTierArg(prefs.serviceTier)}:{}),
      };
      // Each stage is a fresh CLI request, never a continuation of translation deliberation.
      const result=await runAgentRuntime(view.agentId,request,event=>{
        appendEvent(entry,event);
        updateFromEvent(view, event.type === "tool_call" && event.id ? { ...event, id: `${phase}:${event.id}` } : event);
        if(phase!=="translation") { view.phase="aligning"; view.detail="번역을 저장했습니다. 문장별 원문을 연결하고 있습니다."; }
        publish(view);
      });
      if(!grant.inspect().committed) throw new AppError(result.ok?"app_submission_missing":result.error.code,result.ok?(phase === "alignment" ? "연결 작업이 finish-alignment로 완료되지 않았습니다" : "AI가 결과를 제출하지 않았습니다"):publicRunError(result.error).message);
      return result;
    } finally {grant?.revoke();entry.translationToolGrant=null;}
  };
  try {
    if (!alignmentVersionId) firstResult = await execute(prepared.requestText,"translation",raw=>{
      savedResponse=raw;
      const completed=entry.repo.completeFullTextRun({messageId:prepared.messageId,rawResponse:raw,eventsJsonl:collectedEvents(entry),usage:null,resolvedModel:null,runtimeVersion:null});
      versionId=completed.version.versionId;
      view.phase="translation_saved";
      view.detail="번역 전문을 저장했습니다. 원문 연결을 준비합니다.";
      view.validationState="valid";
      publish(view, "translation");
    });
    if(!versionId) throw new AppError("app_submission_missing","번역 전문을 제출하지 않았습니다");
    view.phase="aligning";view.detail="번역을 저장했습니다. 문장별 원문을 연결하고 있습니다.";publish(view);
    const alignmentResult=await execute(alignmentVersionId ? prepared.requestText : entry.repo.prepareAlignment(versionId),"alignment");
    const meta=firstResult??alignmentResult;
    if(savedResponse) entry.repo.finishFullTextRun({messageId:prepared.messageId,rawResponse:savedResponse,eventsJsonl:collectedEvents(entry),usage:meta.usage,resolvedModel:meta.model,runtimeVersion:meta.cliVersion});
    view.state="completed";view.phase="completed";view.detail=alignmentNeedsReview ? "번역과 원문 연결을 저장했습니다. 해결하지 못한 대응과 사유를 확인하세요." : "번역과 문장별 원문 연결을 저장하고 누락 검사를 마쳤습니다. 대응 내용을 검토하세요.";
    view.completedAt=new Date().toISOString();publish(view, "alignment");
  } catch(error) {
    const message=publicRunError({code: error instanceof AppError ? error.code : "provider_failed", message:""}).message;
    if(versionId) {
      entry.repo.failAlignment(versionId,message);
      if(alignmentVersionId) entry.repo.failTranslationRun(prepared.messageId,{code:"alignment_failed",message},{eventsJsonl:collectedEvents(entry)});
      else if(savedResponse) entry.repo.finishFullTextRun({messageId:prepared.messageId,rawResponse:savedResponse,eventsJsonl:collectedEvents(entry),usage:firstResult?.usage??null,resolvedModel:firstResult?.model??null,runtimeVersion:firstResult?.cliVersion??null});
      view.state="completed";view.phase="completed";view.detail="번역은 저장되었습니다. 원문 연결은 완료하지 못해 확인이 필요합니다.";view.validationState="valid";
    } else {
      const code=entry.cancelRequested?"canceled":"translation_failed";
      entry.repo.failTranslationRun(prepared.messageId,{code,message},{eventsJsonl:collectedEvents(entry)});
      view.state=entry.cancelRequested?"canceled":"failed";view.phase=view.state;view.error={code,message};view.detail=message;
    }
    view.completedAt=new Date().toISOString();publish(view);
  } finally { await finishRun(prepared.messageId, entry); }
}

export async function startLegacyTranslationRun(
  repo: ProjectRepo,
  config: AppConfig,
  input: StartTranslationInput,
  sessionStore: RuntimeSessionStore,
): Promise<AiRunView> {
  return withAiLaunch(repo.projectId, async (assertNotCanceled) => {
    const probe = await probeAgentRuntime(input.agentId);
    assertNotCanceled();
    if (!probe.installed) throw new AppError("cli_not_found", `${input.agentId} CLI가 설치되어 있지 않습니다.`);
    if (probe.loggedIn === false) throw new AppError("auth_required", `${input.agentId} CLI 로그인이 필요합니다.`);
    if (probe.loggedIn === null && probe.agentId !== "antigravity") throw new AppError("auth_unknown", `${input.agentId} CLI 로그인 상태를 확인할 수 없습니다.`);
    if (input.alignmentVersionId) {
      const current=repo.getEditor(input.documentNodeId).translation;
      if(current?.versionId!==input.alignmentVersionId || !current.textLayout || !current.isCurrentDependencies) throw new AppError("stale_request", "현재 번역의 연결만 실행할 수 있습니다");
    }
    const prefs = config.agentModels[input.agentId];
    const prepared = repo.beginTranslationRun({
      ...input,
      requestedModel: prefs.model.trim() || "default",
      reasoningLevel: reasoningArg(prefs.reasoning) ?? null,
      serviceTier: input.agentId === "codex" ? (serviceTierArg(prefs.serviceTier) ?? null) : null,
      runtimeVersion: probe.version,
    });
    await persistReservedRunBeforeLaunch(repo, assertNotCanceled, failure => repo.failTranslationRun(prepared.messageId, failure));
    let eventLog: RunEventLog;
    try {
      eventLog = openRunEventLog(repo.packagePath, prepared.messageId);
    } catch (error) {
      repo.failTranslationRun(prepared.messageId, {
        code: "event_log_unavailable",
        message: "AI 실행 event 기록 파일을 만들 수 없습니다",
      });
      throw new AppError(
        "event_log_unavailable",
        error instanceof Error ? error.message : "AI 실행 event 기록 파일을 만들 수 없습니다.",
      );
    }
    const view: AiRunView = {
      messageId: prepared.messageId,
      documentNodeId: input.documentNodeId,
      agentId: input.agentId,
      taskKind: "translation",
      state: "running",
      phase: "starting",
      detail: "CLI 실행을 준비하고 있습니다.",
      partialText: "",
      error: null,
      validationState: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    const entry: ActiveRun = {
      projectId: repo.projectId,
      repo,
      events: [],
      eventBytes: 0,
      eventsTruncated: false,
      eventLog,
      completion: null,
      translationToolGrant: null,
      cancelRequested: false,
    };
    active.set(prepared.messageId, entry);
    publish(view);
    entry.completion = executePrepared(prepared, view, entry, config, sessionStore);
    void entry.completion;
    return cloneRun(view);
  });
}

export async function startTranslationRun(
  repo: ProjectRepo,
  config: AppConfig,
  input: StartTranslationInput,
  sessionStore: RuntimeSessionStore,
): Promise<AiRunView> {
  return withAiLaunch(repo.projectId, async (assertNotCanceled) => {
    const stagePrefs = input.alignmentVersionId ? alignmentPreferences(config, input.agentId) : { agentId: input.agentId, ...config.agentModels[input.agentId] };
    input = { ...input, agentId: stagePrefs.agentId };
    const probe = await probeAgentRuntime(input.agentId);
    assertNotCanceled();
    if (!probe.installed) throw new AppError("cli_not_found", `${input.agentId} CLI가 설치되어 있지 않습니다.`);
    if (probe.loggedIn === false) throw new AppError("auth_required", `${input.agentId} CLI 로그인이 필요합니다.`);
    if (probe.loggedIn === null && probe.agentId !== "antigravity") throw new AppError("auth_unknown", `${input.agentId} CLI 로그인 상태를 확인할 수 없습니다.`);
    if (input.alignmentVersionId) {
      const current=repo.getEditor(input.documentNodeId).translation;
      if(current?.versionId!==input.alignmentVersionId || !current.textLayout || !current.isCurrentDependencies) throw new AppError("stale_request", "현재 번역의 연결만 실행할 수 있습니다");
    }
    const prefs = stagePrefs;
    const prepared = repo.beginFullTextRun({
      ...input,
      requestedModel: prefs.model.trim() || "default",
      reasoningLevel: reasoningArg(prefs.reasoning) ?? null,
      serviceTier: input.agentId === "codex" ? (serviceTierArg(prefs.serviceTier) ?? null) : null,
      runtimeVersion: probe.version,
    });
    await persistReservedRunBeforeLaunch(repo, assertNotCanceled, failure => {
      if (input.alignmentVersionId) repo.failAlignment(input.alignmentVersionId, failure.message);
      repo.failTranslationRun(prepared.messageId, failure);
    });
    let eventLog: RunEventLog;
    try {
      eventLog = openRunEventLog(repo.packagePath, prepared.messageId);
    } catch (error) {
      repo.failTranslationRun(prepared.messageId, {
        code: "event_log_unavailable",
        message: "AI 실행 event 기록 파일을 만들 수 없습니다",
      });
      throw new AppError(
        "event_log_unavailable",
        error instanceof Error ? error.message : "AI 실행 event 기록 파일을 만들 수 없습니다.",
      );
    }
    const view: AiRunView = {
      messageId: prepared.messageId,
      documentNodeId: input.documentNodeId,
      agentId: input.agentId,
      taskKind: "translation",
      state: "running",
      phase: "starting",
      detail: "CLI 실행을 준비하고 있습니다.",
      partialText: "",
      error: null,
      validationState: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    const entry: ActiveRun = {
      projectId: repo.projectId,
      repo,
      events: [],
      eventBytes: 0,
      eventsTruncated: false,
      eventLog,
      completion: null,
      translationToolGrant: null,
      cancelRequested: false,
    };
    active.set(prepared.messageId, entry);
    publish(view);
    entry.completion = executeFullText(prepared, view, entry, config, input.alignmentVersionId);
    void entry.completion;
    return cloneRun(view);
  });
}

export async function startProjectChatRun(
  repo: ProjectRepo,
  config: AppConfig,
  input: StartProjectChatInput,
  sessionStore: RuntimeSessionStore,
): Promise<AiRunView> {
  return withAiLaunch(repo.projectId, async (assertNotCanceled) => {
    const probe = await requireAvailableAgent(input.agentId);
    assertNotCanceled();
    const prefs = config.agentModels[input.agentId];
    const prepared = repo.beginProjectChatRun({
      ...input,
      requestedModel: prefs.model.trim() || "default",
      reasoningLevel: reasoningArg(prefs.reasoning) ?? null,
      serviceTier: input.agentId === "codex" ? (serviceTierArg(prefs.serviceTier) ?? null) : null,
      runtimeVersion: probe.version,
    });
    await persistReservedRunBeforeLaunch(repo, assertNotCanceled, failure => repo.failProjectTaskRun(prepared.messageId, failure));
    const entry = createRunEntry(repo, prepared.messageId, (error) => {
      repo.failProjectTaskRun(prepared.messageId, error);
    });
    const view = initialRunView({
      messageId: prepared.messageId,
      documentNodeId: input.documentNodeId,
      chatScopeKind: input.scopeKind,
      agentId: input.agentId,
      taskKind: "chat",
      detail: prepared.resumeCompatible && readRuntimeSessionRef(sessionStore, {
        providerKind: input.agentId,
        projectId: repo.projectId,
        threadId: prepared.threadId,
      })
        ? "기존 CLI 대화를 이어 답변을 준비합니다."
        : "새 프로젝트 채팅 답변을 준비합니다.",
    });
    active.set(prepared.messageId, entry);
    publish(view);
    entry.completion = executeProjectTask(prepared, view, entry, config, sessionStore);
    void entry.completion;
    return cloneRun(view);
  });
}

export async function startPunctuationSuggestionRun(
  repo: ProjectRepo,
  config: AppConfig,
  input: StartPunctuationSuggestionInput,
  sessionStore: RuntimeSessionStore,
): Promise<AiRunView> {
  return withAiLaunch(repo.projectId, async (assertNotCanceled) => {
    const probe = await requireAvailableAgent(input.agentId);
    assertNotCanceled();
    const prefs = config.agentModels[input.agentId];
    const prepared = repo.beginPunctuationSuggestionRun({
      ...input,
      requestedModel: prefs.model.trim() || "default",
      reasoningLevel: reasoningArg(prefs.reasoning) ?? null,
      serviceTier: input.agentId === "codex" ? (serviceTierArg(prefs.serviceTier) ?? null) : null,
      runtimeVersion: probe.version,
    });
    await persistReservedRunBeforeLaunch(repo, assertNotCanceled, failure => repo.failProjectTaskRun(prepared.messageId, failure));
    const entry = createRunEntry(repo, prepared.messageId, (error) => {
      repo.failProjectTaskRun(prepared.messageId, error);
    });
    const view = initialRunView({
      messageId: prepared.messageId,
      documentNodeId: input.documentNodeId,
      agentId: input.agentId,
      taskKind: "punctuation_suggest",
      detail: "원문 전체에서 표점·구조 제안을 준비합니다.",
    });
    active.set(prepared.messageId, entry);
    publish(view);
    entry.completion = executeProjectTask(prepared, view, entry, config, sessionStore);
    void entry.completion;
    return cloneRun(view);
  });
}

export function getTranslationRun(messageId: string): AiRunView {
  const run = runs.get(messageId);
  if (!run) throw new AppError("not_found", "AI 실행 기록을 찾을 수 없습니다.");
  return cloneRun(run);
}

export async function cancelTranslationRun(messageId: string): Promise<AiRunView> {
  const run = runs.get(messageId);
  if (!run) throw new AppError("not_found", "AI 실행 기록을 찾을 수 없습니다.");
  const entry = active.get(messageId);
  if (!entry) return cloneRun(run);
  entry.cancelRequested = true;
  entry.translationToolGrant?.revoke();
  run.phase = "stopping";
  run.detail = "CLI 프로세스를 종료하고 있습니다.";
  publish(run);
  await cancelAgentRuntime(messageId);
  return cloneRun(runs.get(messageId) ?? run);
}

export function hasActiveAiRuns(projectId?: string): boolean {
  for (const entry of launches) {
    if (!projectId || entry.projectId === projectId) return true;
  }
  for (const entry of active.values()) {
    if (!projectId || entry.projectId === projectId) return true;
  }
  for (const entry of externalActivities.values()) {
    if (!projectId || entry.projectId === projectId) return true;
  }
  return false;
}

export async function cancelAllAiRuns(): Promise<void> {
  cancelingActivities += 1;
  try {
    const preparing = [...launches];
    for (const entry of preparing) entry.canceled = true;
    const entries = [...active.entries()];
    const external = [...externalActivities.values()];
    for (const [, entry] of entries) {
      entry.cancelRequested = true;
      entry.translationToolGrant?.revoke();
    }
    await Promise.allSettled([...entries.map(([messageId]) => cancelAgentRuntime(messageId)), ...external.map(entry => Promise.resolve().then(() => entry.cancel()))]);
    await Promise.allSettled([...entries.map(([, entry]) => entry.completion), ...external.map(entry => entry.completion), ...preparing.map(entry => entry.completion)]);
    await Promise.allSettled([...pendingPersistence]);
  } finally { cancelingActivities -= 1; }
}
