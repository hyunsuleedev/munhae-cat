import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, MunhaeError, sha256Hex } from "@munhae/domain";
import {
  openAppDatabase,
  createProject,
  openProject,
  openSqlite,
  sanitizeAgentEventForPersistence,
  type AppDb,
  type ProjectRepo,
  type SqliteDb,
} from "../src/index.ts";
import { sqlitePath } from "../src/project-repo.ts";

const dirs: string[] = [];
const repos: ProjectRepo[] = [];
const databases: SqliteDb[] = [];
const appDatabases: AppDb[] = [];

type ReadyEditor = ReturnType<ProjectRepo["getEditor"]> & {
  punctuation: NonNullable<ReturnType<ProjectRepo["getEditor"]>["punctuation"]> & { anchorSetId: string };
};

function readyEditor(editor: ReturnType<ProjectRepo["getEditor"]>): ReadyEditor {
  if (!editor.punctuation?.anchorSetId) throw new Error("test fixture requires confirmed punctuation anchors");
  return editor as ReadyEditor;
}

afterEach(() => {
  while (databases.length) {
    try {
      databases.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (repos.length) {
    try {
      repos.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (appDatabases.length) {
    try {
      appDatabases.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function expectMunhaeCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected MunhaeError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(MunhaeError);
    expect((error as MunhaeError).code).toBe(code);
  }
}

function setup(sourceText = "天地玄黃宇宙洪荒") {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-ai-tasks-"));
  dirs.push(parentDir);
  const repo = createProject({ title: "AI task ledger", parentDir }).handle;
  repos.push(repo);
  const root = repo.getHome().documents.find((item) => item.isMaster)!;
  const document = repo.createDocument({
    title: "천자문",
    parentId: root.id,
    nodeRole: "source_unit",
    originKind: "paste",
    sourceText,
  });
  let editor = repo.getEditor(document.id);
  editor = repo.confirmSource({ documentNodeId: document.id, expectedLockVersion: editor.source.lockVersion });
  editor = repo.createPunctuationDraftFromConfirmedSource({
    documentNodeId: document.id,
    structureMode: "prose",
    expectedSourceLockVersion: editor.source.lockVersion,
  });
  editor = repo.confirmPunctuation({
    documentNodeId: document.id,
    expectedLockVersion: editor.punctuation!.lockVersion,
  });
  const db = openSqlite(sqlitePath(repo.packagePath));
  databases.push(db);
  return { repo, db, document, editor: readyEditor(editor) };
}

function counts(db: SqliteDb) {
  return {
    source: (db.prepare("SELECT COUNT(*) AS n FROM src_text_versions").get() as { n: number }).n,
    punctuation: (db.prepare("SELECT COUNT(*) AS n FROM punctuation_versions").get() as { n: number }).n,
    translation: (db.prepare("SELECT COUNT(*) AS n FROM document_translation_versions").get() as { n: number }).n,
  };
}

describe("app-local provider sessions", () => {
  it("round-trips, replaces, isolates, and clears provider session refs", () => {
    const userDataDir = mkdtempSync(join(tmpdir(), "munhae-app-session-"));
    dirs.push(userDataDir);
    const appDb = openAppDatabase(userDataDir);
    appDatabases.push(appDb);
    const codex = { providerKind: "codex", projectId: "project-1", threadId: "thread-1" } as const;
    const claude = { providerKind: "claude", projectId: "project-1", threadId: "thread-1" } as const;

    expect(appDb.getRuntimeSessionRef(codex)).toBeNull();
    appDb.setRuntimeSessionRef(codex, "codex-session-one");
    appDb.setRuntimeSessionRef(claude, "claude-session-one");
    expect(appDb.getRuntimeSessionRef(codex)).toBe("codex-session-one");
    expect(appDb.getRuntimeSessionRef(claude)).toBe("claude-session-one");

    appDb.setRuntimeSessionRef(codex, "codex-session-two");
    expect(appDb.getRuntimeSessionRef(codex)).toBe("codex-session-two");
    appDb.clearRuntimeSession(codex);
    expect(appDb.getRuntimeSessionRef(codex)).toBeNull();
    expect(appDb.getRuntimeSessionRef(claude)).toBe("claude-session-one");
  });
});

describe("agent event persistence sanitizer", () => {
  const base = {
    runId: "01900000-0000-7000-8000-000000000099",
    agentId: "codex",
    at: "2026-09-04T00:00:00.000Z",
  } as const;
  const secret = "SENTINEL-source-token-session-path-command-result";

  it("rebuilds known events from metadata allowlists and drops payload-bearing events", () => {
    expect(sanitizeAgentEventForPersistence({
      type: "status",
      ...base,
      phase: "streaming",
      detail: `/tmp/${secret}`,
      model: secret,
      source: secret,
    })).toEqual({ type: "status", ...base, phase: "streaming" });

    expect(sanitizeAgentEventForPersistence({
      type: "tool_call",
      ...base,
      name: "Bash",
      state: "started",
      input: secret,
      result: secret,
      args: [secret],
      command: secret,
      env: { MUNHAE_TOOL_GRANT: secret },
      cwd: `/tmp/${secret}`,
      path: `/tmp/${secret}`,
      source: secret,
    })).toEqual({ type: "tool_call", ...base, state: "started" });

    expect(sanitizeAgentEventForPersistence({
      type: "session",
      ...base,
      sessionRef: secret,
      payload: { source: secret },
    })).toEqual({
      type: "status",
      ...base,
      phase: "initializing",
      detail: "provider_session_ready",
    });

    expect(sanitizeAgentEventForPersistence({
      type: "warning",
      ...base,
      message: secret,
      stderr: secret,
    })).toEqual({ type: "warning", ...base });

    expect(sanitizeAgentEventForPersistence({
      type: "error",
      ...base,
      error: {
        code: "provider_failed",
        retryable: true,
        message: secret,
        stderr: secret,
        signal: secret,
        path: `/tmp/${secret}`,
      },
      raw: secret,
    })).toEqual({
      type: "error",
      ...base,
      error: { code: "provider_failed", retryable: true },
    });

    expect(sanitizeAgentEventForPersistence({ type: "text_delta", ...base, text: secret })).toBeNull();
    expect(sanitizeAgentEventForPersistence({ type: "thinking_delta", ...base, text: secret })).toBeNull();
    expect(sanitizeAgentEventForPersistence({
      type: "usage",
      ...base,
      usage: { inputTokens: 123, outputTokens: 456, token: secret },
    })).toBeNull();
  });

  it("fails closed for malformed metadata, tool names, and future event types", () => {
    expect(sanitizeAgentEventForPersistence({
      type: "status",
      phase: "streaming",
      runId: secret,
      agentId: secret,
      at: secret,
    })).toEqual({ type: "status", phase: "streaming" });
    expect(sanitizeAgentEventForPersistence({
      type: "tool_call",
      ...base,
      name: `/tmp/${secret}`,
      state: "completed",
    })).toEqual({ type: "tool_call", ...base, state: "completed" });
    expect(sanitizeAgentEventForPersistence({
      type: "tool_call",
      ...base,
      name: "Bash",
      state: secret,
    })).toBeNull();
    expect(sanitizeAgentEventForPersistence({
      type: "error",
      ...base,
      error: { code: secret, retryable: false, message: secret },
    })).toEqual({
      type: "error",
      ...base,
      error: { code: "provider_failed", retryable: false },
    });
    expect(sanitizeAgentEventForPersistence({
      type: "future_provider_event",
      ...base,
      payload: { text: secret },
    })).toBeNull();
  });

  it("never serializes prohibited payload sentinels", () => {
    const events = [
      { type: "text_delta", ...base, text: secret },
      { type: "thinking_delta", ...base, text: secret },
      {
        type: "tool_call",
        ...base,
        name: "Bash",
        state: "failed",
        input: secret,
        result: secret,
      },
      { type: "session", ...base, sessionRef: secret },
      { type: "warning", ...base, message: secret },
      {
        type: "error",
        ...base,
        error: { code: "provider_failed", retryable: false, message: secret, stderr: secret },
      },
      { type: "usage", ...base, usage: { inputTokens: 12, token: secret } },
    ];
    const persistedJsonl = events
      .map((event) => sanitizeAgentEventForPersistence(event))
      .filter((event) => event !== null)
      .map((event) => JSON.stringify(event))
      .join("\n");
    expect(persistedJsonl).not.toContain(secret);
    expect(persistedJsonl).not.toContain("inputTokens");
    expect(persistedJsonl).not.toContain("sessionRef");
    expect(persistedJsonl).not.toContain("stderr");
  });
});

describe("project chat ledger", () => {
  it("keeps document and project conversations independent and sends only the safe project overview", () => {
    const value = setup();
    const master = value.repo.getHome().documents.find((item) => item.isMaster)!;
    const secondDocument = value.repo.createDocument({
      title: "둘째 문서",
      parentId: master.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "SENTINEL_SECOND_DOCUMENT_SOURCE",
    });
    value.repo.createContextItem({
      scopeId: master.id,

      title: "프로젝트 공통 설명",
      contentMd: "ENABLED_PROJECT_MASTER_CONTEXT",
      priority: 50,
      enabled: true,
    });
    value.repo.createContextItem({
      scopeId: master.id,

      title: "비활성 문맥",
      contentMd: "SENTINEL_DISABLED_CONTEXT",
      priority: 100,
      enabled: false,
    });

    const documentChat = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "현재 문서 질문",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(documentChat.promptContractVersion).toBe("munhae.project-chat.v3");
    expect(documentChat.requestText).toContain("native tools, web access, and installed skills");
    expect(documentChat.requestText).toContain("never claim that Munhae project data was changed");
    expect(documentChat.requestText).not.toContain("Do not call tools");
    value.repo.completeProjectChatRun({
      messageId: documentChat.messageId,
      rawResponse: "현재 문서 답변",
      eventsJsonl: "",
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });

    const projectChat = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "project",
      question: "프로젝트 진행 상황은?",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(projectChat.resumeCompatible).toBe(false);
    expect(projectChat.threadId).not.toBe(documentChat.threadId);
    expect(projectChat.requestText).toContain("[SCOPE project]");
    expect(projectChat.requestText).toContain("AI task ledger");
    expect(projectChat.requestText).toContain(secondDocument.title);
    expect(projectChat.requestText).toContain("ENABLED_PROJECT_MASTER_CONTEXT");
    expect(projectChat.requestText).not.toContain("天地玄黃宇宙洪荒");
    expect(projectChat.requestText).not.toContain("SENTINEL_SECOND_DOCUMENT_SOURCE");
    expect(projectChat.requestText).not.toContain("SENTINEL_DISABLED_CONTEXT");
    expect(value.db.prepare(
      "SELECT scope_kind, scope_id FROM chat_threads WHERE id = ?",
    ).get(projectChat.threadId)).toEqual({ scope_kind: "project", scope_id: value.repo.projectId });

    value.repo.completeProjectChatRun({
      messageId: projectChat.messageId,
      rawResponse: "프로젝트 전체 답변",
      eventsJsonl: "",
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });
    expect(value.repo.getChat({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
    }).map((message) => message.text)).toEqual(["현재 문서 질문", "현재 문서 답변"]);
    expect(value.repo.getChat({
      documentNodeId: value.document.id,
      scopeKind: "project",
    }).map((message) => message.text)).toEqual(["프로젝트 진행 상황은?", "프로젝트 전체 답변"]);
  });

  it("keeps ordinary chat session continuity across translation work and guards scope resumes", () => {
    const value = setup();
    const first = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "첫 문서 채팅",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    value.repo.completeProjectChatRun({
      messageId: first.messageId,
      rawResponse: "첫 답변",
      eventsJsonl: "",
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });
    value.repo.recordProjectAgentSession({
      messageId: first.messageId,
      threadId: first.threadId,
      agentId: "codex",
      requestedModel: first.requestedModel,
      stablePromptHash: first.stablePromptHash,
    });

    const translation = value.repo.beginTranslationRun({
      documentNodeId: value.document.id,
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(translation.threadId).not.toBe(first.threadId);
    value.repo.failTranslationRun(translation.messageId, { code: "test_cleanup", message: "test cleanup" });
    expect(value.db.prepare(
      "SELECT last_message_id FROM chat_agent_sessions WHERE thread_id = ? AND agent_id = 'codex'",
    ).get(first.threadId)).toEqual({ last_message_id: first.messageId });

    const project = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "project",
      question: "프로젝트 범위 첫 질문",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(project.resumeCompatible).toBe(false);
    expect(project.threadId).not.toBe(first.threadId);
    value.repo.failProjectTaskRun(project.messageId, { code: "canceled", message: "test cleanup" });

    const continued = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "첫 문서 채팅을 이어서",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(continued.threadId).toBe(first.threadId);
    expect(continued.resumeCompatible).toBe(true);
    value.repo.failProjectTaskRun(continued.messageId, { code: "canceled", message: "test cleanup" });
  });

  it("runs against a source-only document without creating punctuation or translations", () => {
    const value = setup();
    const root = value.repo.getHome().documents.find((item) => item.isMaster)!;
    const sourceOnly = value.repo.createDocument({
      title: "원문만 있는 문서",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "學而時習之",
    });
    const editor = value.repo.getEditor(sourceOnly.id);
    expect(editor.punctuation).toBeNull();
    expect(editor.anchors).toEqual([]);
    const before = counts(value.db);
    const prepared = value.repo.beginProjectChatRun({
      documentNodeId: sourceOnly.id,
      scopeKind: "document_node",
      question: "이 문장의 문법 구조를 설명해 주세요.",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(prepared.requestText).toContain("[PUNCTUATION not_created]");
    expect(prepared.requestText).toContain("學而時習之");
    value.repo.completeProjectChatRun({
      messageId: prepared.messageId,
      rawResponse: "學은 주어이고 習은 서술어입니다.",
      eventsJsonl: "",
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });
    expect(counts(value.db)).toEqual(before);
    const after = value.repo.getEditor(sourceOnly.id);
    expect(after.punctuation).toBeNull();
    expect(after.anchors).toEqual([]);
    expect(after.translation).toBeNull();
  });

  it("serializes a document thread, stores exact provenance, and never mutates translation data", () => {
    const value = setup();
    const before = counts(value.db);
    const prepared = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "두 구절의 대비를 설명해 주세요.",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(prepared.requestText).toContain("天地玄黃宇宙洪荒");
    expect(prepared.requestText).toContain("두 구절의 대비를 설명해 주세요.");
    expect(prepared.requestText).not.toContain("submit_translation");

    expectMunhaeCode(() => value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "같은 문서 채팅 thread에는 동시에 요청할 수 없습니다.",
      agentId: "claude",
      requestedModel: "default",
      reasoningLevel: null,
      serviceTier: null,
      runtimeVersion: "claude-cli test",
    }), "thread_busy");

    const providerSessionRef = "provider-session-raw-secret";
    const rawEventPayload = "raw-stream-source-tool-secret";
    const safeEvent = sanitizeAgentEventForPersistence({
      type: "session",
      runId: prepared.messageId,
      agentId: "codex",
      at: "2026-09-04T00:00:00.000Z",
      sessionRef: providerSessionRef,
    });
    const eventsJsonl = [
      safeEvent,
      sanitizeAgentEventForPersistence({
        type: "text_delta",
        runId: prepared.messageId,
        agentId: "codex",
        at: "2026-09-04T00:00:01.000Z",
        text: rawEventPayload,
      }),
      sanitizeAgentEventForPersistence({
        type: "tool_call",
        runId: prepared.messageId,
        agentId: "codex",
        at: "2026-09-04T00:00:02.000Z",
        name: "Bash",
        state: "completed",
        input: rawEventPayload,
        result: rawEventPayload,
      }),
    ]
      .filter((event) => event !== null)
      .map((event) => `${JSON.stringify(event)}\n`)
      .join("");
    const response = "첫 구절은 천지의 빛깔을, 둘째 구절은 우주의 넓이를 병치합니다.";
    value.repo.completeProjectChatRun({
      messageId: prepared.messageId,
      rawResponse: response,
      eventsJsonl,
      usage: { input_tokens: 12, output_tokens: 18 },
      resolvedModel: "gpt-test-resolved",
      runtimeVersion: "codex-cli test",
    });
    expect(counts(value.db)).toEqual(before);

    const stored = value.db.prepare(
      `SELECT m.state, m.task_kind, m.output_validation_state,
              request.payload_text AS request_text, response.payload_text AS response_text,
              events.payload_text AS events_text
       FROM chat_messages m
       JOIN provenance_artifacts request ON request.id = m.request_artifact_id
       JOIN provenance_artifacts response ON response.id = m.response_artifact_id
       JOIN provenance_artifacts events ON events.id = m.events_artifact_id
       WHERE m.id = ?`,
    ).get(prepared.messageId) as Record<string, unknown>;
    expect(stored).toMatchObject({
      state: "completed",
      task_kind: "chat",
      output_validation_state: "not_applicable",
      request_text: prepared.requestText,
      response_text: response,
      events_text: eventsJsonl,
    });
    expect(JSON.stringify(stored)).not.toContain(providerSessionRef);
    expect(JSON.stringify(stored)).not.toContain(rawEventPayload);
    expect(JSON.stringify(safeEvent)).toContain("provider_session_ready");
    expect(JSON.stringify(safeEvent)).not.toContain(providerSessionRef);
    expect(value.repo.getChat({ documentNodeId: value.document.id, scopeKind: "document_node" }).slice(-2)).toEqual([
      expect.objectContaining({ role: "user", text: "두 구절의 대비를 설명해 주세요." }),
      expect.objectContaining({ role: "assistant", text: response, meta: "codex" }),
    ]);

    value.repo.recordProjectAgentSession({
      messageId: prepared.messageId,
      threadId: prepared.threadId,
      agentId: "codex",
      requestedModel: prepared.requestedModel,
      stablePromptHash: prepared.stablePromptHash,
    });
    const sessionMetadata = value.db.prepare(
      `SELECT model, last_message_id, stable_prompt_hash, state
       FROM chat_agent_sessions WHERE thread_id = ? AND agent_id = 'codex'`,
    ).get(prepared.threadId) as Record<string, unknown>;
    expect(sessionMetadata).toMatchObject({
      model: "gpt-test",
      last_message_id: prepared.messageId,
      stable_prompt_hash: prepared.stablePromptHash,
      state: "active",
    });

    const continued = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "앞 답변을 한 문장으로 줄여 주세요.",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    expect(continued.resumeCompatible).toBe(true);
    value.repo.failProjectTaskRun(continued.messageId, { code: "canceled", message: "test cleanup" });
  });

  it("returns only completed chat requests and replies from a mixed document AI thread", () => {
    const value = setup();
    const translation = value.repo.beginTranslationRun({
      documentNodeId: value.document.id,
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    const translationResponse = JSON.stringify({
      schemaVersion: 2,
      anchorSetId: value.editor.punctuation.anchorSetId,
      blocks: value.editor.anchors.map((anchor, index) => ({
        blockKey: `B${String(index + 1).padStart(3, "0")}`,
        sourceAnchorIds: [anchor.anchorKey],
        blockKind: anchor.boundaryKind,
        translation: `비공개 번역 실행 ${index + 1}`,
      })),
    });
    value.repo.completeTranslationRun({
      messageId: translation.messageId,
      rawResponse: translationResponse,
      eventsJsonl: "",
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });

    const punctuation = value.repo.beginPunctuationSuggestionRun({
      documentNodeId: value.document.id,
      structureMode: "prose",
      agentId: "claude",
      requestedModel: "claude-test",
      reasoningLevel: "high",
      serviceTier: null,
      runtimeVersion: "claude-cli test",
    });
    value.repo.completePunctuationSuggestionRun({
      messageId: punctuation.messageId,
      rawResponse: "天地玄黃，宇宙洪荒。",
      eventsJsonl: "",
      usage: null,
      resolvedModel: "claude-test",
      runtimeVersion: "claude-cli test",
    });

    const chat = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "두 구절의 관계를 설명해 주세요.",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    value.repo.completeProjectChatRun({
      messageId: chat.messageId,
      rawResponse: "천지와 우주의 상태를 짝지어 제시한 구절입니다.",
      eventsJsonl: "",
      usage: null,
      resolvedModel: "gpt-test",
      runtimeVersion: "codex-cli test",
    });

    const expected = [
      expect.objectContaining({ role: "user", text: "두 구절의 관계를 설명해 주세요." }),
      expect.objectContaining({
        role: "assistant",
        text: "천지와 우주의 상태를 짝지어 제시한 구절입니다.",
        meta: "codex",
      }),
    ];
    expect(value.repo.getChat({ documentNodeId: value.document.id, scopeKind: "document_node" })).toEqual(expected);
    expect(value.repo.getEditor(value.document.id).chat).toEqual(expected);
  });

  it("preserves run events when interrupted chat and punctuation tasks are recovered", () => {
    const value = setup();
    const packagePath = value.repo.packagePath;
    const chat = value.repo.beginProjectChatRun({
      documentNodeId: value.document.id,
      scopeKind: "document_node",
      question: "중단 복구를 검사합니다.",
      agentId: "codex",
      requestedModel: "gpt-test",
      reasoningLevel: "medium",
      serviceTier: "default",
      runtimeVersion: "codex-cli test",
    });
    const chatEvents = '{"type":"status","phase":"streaming","detail":"chat partial"}\n';
    const chatRunDir = join(packagePath, "runs", chat.messageId);
    mkdirSync(chatRunDir, { recursive: true });
    writeFileSync(join(chatRunDir, "events.jsonl"), chatEvents, "utf8");
    value.repo.close();

    const firstRecovery = openProject(packagePath);
    repos.push(firstRecovery);
    const recoveredChat = value.db.prepare(
      `SELECT message.state, message.error_json, artifact.payload_text AS events_text
       FROM chat_messages message
       JOIN provenance_artifacts artifact ON artifact.id = message.events_artifact_id
       WHERE message.id = ?`,
    ).get(chat.messageId) as Record<string, unknown>;
    expect(recoveredChat).toMatchObject({ state: "failed", events_text: chatEvents });
    expect(String(recoveredChat.error_json)).toContain("interrupted");

    const punctuation = firstRecovery.beginPunctuationSuggestionRun({
      documentNodeId: value.document.id,
      structureMode: "prose",
      agentId: "claude",
      requestedModel: "claude-test",
      reasoningLevel: null,
      serviceTier: null,
      runtimeVersion: "claude-cli test",
    });
    const punctuationEvents = '{"type":"status","phase":"streaming","detail":"punctuation partial"}\n';
    const punctuationRunDir = join(packagePath, "runs", punctuation.messageId);
    mkdirSync(punctuationRunDir, { recursive: true });
    writeFileSync(join(punctuationRunDir, "events.jsonl"), punctuationEvents, "utf8");
    firstRecovery.close();

    const secondRecovery = openProject(packagePath);
    repos.push(secondRecovery);
    const recoveredPunctuation = value.db.prepare(
      `SELECT message.state, message.error_json, artifact.payload_text AS events_text
       FROM chat_messages message
       JOIN provenance_artifacts artifact ON artifact.id = message.events_artifact_id
       WHERE message.id = ?`,
    ).get(punctuation.messageId) as Record<string, unknown>;
    expect(recoveredPunctuation).toMatchObject({ state: "failed", events_text: punctuationEvents });
    expect(String(recoveredPunctuation.error_json)).toContain("interrupted");
  });
});

describe("AI punctuation proposals", () => {
  it("accepts an omitted trailing space and keeps source bytes and anchor coverage", () => {
    const sourceText = " \t天地玄黃\n宇宙洪荒〇𠀀 ";
    const { repo, db, document } = setup(sourceText);
    const before = repo.getEditor(document.id).source;
    const prepared = repo.beginPunctuationSuggestionRun({
      documentNodeId: document.id, structureMode: "prose", agentId: "codex",
      requestedModel: "default", reasoningLevel: "medium", serviceTier: null, runtimeVersion: null,
    });
    const responseText = "天地玄黃。宇宙洪荒〇𠀀。";
    expect(repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId, rawResponse: responseText, eventsJsonl: "", usage: null,
      resolvedModel: null, runtimeVersion: null,
    })).toMatchObject({ validationState: "valid", applied: false });
    repo.applyPunctuationSuggestionRun(prepared.messageId);
    const draft = repo.getEditor(document.id);
    expect(draft.source).toEqual(before);
    const confirmed = repo.confirmPunctuation({ documentNodeId: document.id, expectedLockVersion: draft.punctuation!.lockVersion });
    expect(confirmed.source.contentText).toBe(sourceText);
    const anchors = db.prepare(`SELECT source_quote FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal`)
      .all(confirmed.punctuation!.anchorSetId) as Array<{ source_quote: string }>;
    expect(anchors.map((anchor) => anchor.source_quote).join("")).toBe(sourceText);
  });

  it.each(["munhae.punctuation-suggest.v3", "munhae.punctuation-suggest.v4"])(
    "does not let trailing whitespace hide a forbidden new mark under %s", (contract) => {
      const { repo, db, document } = setup("天地玄黃宇宙洪荒 ");
      const prepared = repo.beginPunctuationSuggestionRun({
        documentNodeId: document.id, structureMode: "prose", agentId: "codex",
        requestedModel: "default", reasoningLevel: "medium", serviceTier: null, runtimeVersion: null,
      });
      db.prepare("UPDATE chat_messages SET prompt_contract_version = ? WHERE id = ?").run(contract, prepared.messageId);
      expect(repo.completePunctuationSuggestionRun({
        messageId: prepared.messageId, rawResponse: "天地玄黃，宇宙洪荒？", eventsJsonl: "", usage: null,
        resolvedModel: null, runtimeVersion: null,
      })).toMatchObject({ validationState: "invalid_unapplied", applied: false });
      expect(repo.getLatestPunctuationSuggestion(document.id)).toMatchObject({
        validationState: "invalid_unapplied", validationError: expect.stringContaining("'？'"),
      });
    },
  );

  it("revalidates a historical whitespace rejection without changing response evidence or applying it", () => {
    const { repo, db, document } = setup("天地玄黃宇宙洪荒 ");
    const prepared = repo.beginPunctuationSuggestionRun({
      documentNodeId: document.id, structureMode: "prose", agentId: "codex",
      requestedModel: "default", reasoningLevel: "medium", serviceTier: null, runtimeVersion: null,
    });
    const responseText = "天地玄黃，宇宙洪荒。";
    repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId, rawResponse: responseText, eventsJsonl: "", usage: null,
      resolvedModel: null, runtimeVersion: null,
    });
    const error = { code: "invalid_punctuation_suggestion", message: "표점안에서 원문 문자 ' '가 삭제되거나 순서가 바뀌었습니다" };
    const storedManifest = db.prepare("SELECT request_manifest_json FROM chat_messages WHERE id = ?")
      .get(prepared.messageId) as { request_manifest_json: string };
    const manifest = JSON.parse(storedManifest.request_manifest_json);
    manifest.promptContractVersion = "munhae.punctuation-suggest.v3";
    const manifestJson = canonicalJson(manifest);
    db.prepare(`UPDATE chat_messages SET output_validation_state = 'invalid_unapplied', error_json = ?,
      prompt_contract_version = 'munhae.punctuation-suggest.v3', request_manifest_json = ?, request_manifest_hash = ? WHERE id = ?`)
      .run(canonicalJson(error), manifestJson, sha256Hex(manifestJson), prepared.messageId);
    db.prepare("UPDATE chat_message_parts SET structured_json = ? WHERE message_id = ? AND ordinal = 1")
      .run(canonicalJson({ validationState: "invalid_unapplied", message: error.message }), prepared.messageId);
    const before = counts(db);
    const evidence = () => db.prepare(`SELECT m.completed_at, m.response_artifact_id, a.raw_sha256, a.payload_text
      FROM chat_messages m JOIN provenance_artifacts a ON a.id = m.response_artifact_id WHERE m.id = ?`).get(prepared.messageId);
    const originalEvidence = evidence();
    expect(repo.getLatestPunctuationSuggestion(document.id)).toMatchObject({ validationState: "valid", validationError: null, applied: false, responseText });
    expect(counts(db)).toEqual(before);
    expect(evidence()).toEqual(originalEvidence);
    const audit = () => JSON.parse((db.prepare("SELECT structured_json FROM chat_message_parts WHERE message_id = ? AND ordinal = 1")
      .get(prepared.messageId) as { structured_json: string }).structured_json);
    expect(audit().revalidation.previousError).toEqual(error);
    const firstAudit = audit();
    repo.getLatestPunctuationSuggestion(document.id);
    expect(audit()).toEqual(firstAudit);
    repo.applyPunctuationSuggestionRun(prepared.messageId);
    expect(audit().revalidation).toEqual(firstAudit.revalidation);
    expect(repo.getEditor(document.id).punctuation).toMatchObject({ state: "draft", punctuatedText: responseText });
  });
  it.each(["?", "？", "!", "！", ":", "：", ";", "；", "、", "「」"])(
    "preserves a response with newly inserted %s as an invalid, unapplied proposal",
    (mark) => {
      const { repo, db, document, editor } = setup();
      const before = counts(db);
      const prepared = repo.beginPunctuationSuggestionRun({
        documentNodeId: document.id, structureMode: "prose", agentId: "codex",
        requestedModel: "default", reasoningLevel: "medium", serviceTier: null, runtimeVersion: null,
      });
      const rawResponse = `天地玄黃${mark}宇宙洪荒。`;
      const result = repo.completePunctuationSuggestionRun({
        messageId: prepared.messageId, rawResponse, eventsJsonl: "", usage: null,
        resolvedModel: null, runtimeVersion: null,
      });
      expect(result).toMatchObject({ validationState: "invalid_unapplied", applied: false });
      expect(repo.getLatestPunctuationSuggestion(document.id)).toMatchObject({ responseText: rawResponse });
      const stored = db.prepare("SELECT error_json FROM chat_messages WHERE id = ?")
        .get(prepared.messageId) as { error_json: string };
      expect(stored.error_json).toContain("보수적 표점 형식에 없는 부호");
      expectMunhaeCode(() => repo.applyPunctuationSuggestionRun(prepared.messageId), "invalid_punctuation_suggestion");
      expect(repo.getEditor(document.id).punctuation?.versionId).toBe(editor.punctuation.versionId);
      expect(counts(db)).toEqual(before);
    },
  );

  it("accepts conservative punctuation while preserving existing source marks and supplementary characters", () => {
    const { repo } = setup();
    const root = repo.getHome().documents.find((item) => item.isMaster)!;
    const sourceText = "臣謹案周禮禮典天神地示人鬼抑何故也？〇𠀀○";
    const document = repo.createDocument({
      title: "표점 관례", parentId: root.id, nodeRole: "source_unit", originKind: "paste", sourceText,
    });
    const editor = repo.getEditor(document.id);
    repo.confirmSource({ documentNodeId: document.id, expectedLockVersion: editor.source.lockVersion });
    const prepared = repo.beginPunctuationSuggestionRun({
      documentNodeId: document.id, structureMode: "prose", agentId: "claude",
      requestedModel: "default", reasoningLevel: "medium", serviceTier: null, runtimeVersion: null,
    });
    const rawResponse = "臣謹案 《周禮》〈禮典〉，天神ㆍ地示ㆍ人鬼。\n抑何故也？〇𠀀○";
    expect(repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId, rawResponse, eventsJsonl: "", usage: null,
      resolvedModel: null, runtimeVersion: null,
    })).toMatchObject({ validationState: "valid", applied: false });
    repo.applyPunctuationSuggestionRun(prepared.messageId);
    const after = repo.getEditor(document.id);
    expect(after.source.contentText).toBe(sourceText);
    expect(after.punctuation).toMatchObject({ punctuatedText: rawResponse, state: "draft" });
  });

  it("validates an in-flight historical response using its original punctuation contract", () => {
    const { repo, db, document } = setup();
    const prepared = repo.beginPunctuationSuggestionRun({
      documentNodeId: document.id, structureMode: "prose", agentId: "codex",
      requestedModel: "default", reasoningLevel: "medium", serviceTier: null, runtimeVersion: null,
    });
    // Simulate a v2 request that was already in flight when the app updated.
    db.prepare("UPDATE chat_messages SET prompt_contract_version = ? WHERE id = ?")
      .run("munhae.punctuation-suggest.v2", prepared.messageId);
    expect(repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId, rawResponse: "天地玄黃，宇宙洪荒？", eventsJsonl: "", usage: null,
      resolvedModel: null, runtimeVersion: null,
    })).toMatchObject({ validationState: "valid", applied: false });
    expect(repo.applyPunctuationSuggestionRun(prepared.messageId)).toMatchObject({ applied: true });
  });

  it("keeps a validated proposal unapplied until explicit consent, then creates an unconfirmed AI draft", () => {
    const value = setup();
    const before = counts(value.db);
    const confirmedBefore = value.editor.punctuation.versionId;
    const prepared = value.repo.beginPunctuationSuggestionRun({
      documentNodeId: value.document.id,
      structureMode: "prose",
      agentId: "claude",
      requestedModel: "claude-test",
      reasoningLevel: "high",
      serviceTier: null,
      runtimeVersion: "claude-cli test",
    });
    expect(prepared.promptContractVersion).toBe("munhae.punctuation-suggest.v4");
    expect(prepared.requestText).toContain("native tools, web access, and installed skills");
    expect(prepared.requestText).toContain("do not attempt to change Munhae app data");
    expect(prepared.requestText).not.toContain("Do not call tools");
    expect(prepared.requestText).not.toContain("submit_translation");
    const rawResponse = "天地玄黃，宇宙洪荒。";
    const completed = value.repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId,
      rawResponse,
      eventsJsonl: '{"type":"status","phase":"streaming"}\n',
      usage: { input_tokens: 8, output_tokens: 10 },
      resolvedModel: "claude-test",
      runtimeVersion: "claude-cli test",
    });
    expect(completed.validationState).toBe("valid");
    expect(completed).toMatchObject({ applied: false, punctuationVersionId: null, anchorSetId: null });
    expect(counts(value.db)).toEqual(before);
    const unchanged = value.repo.getEditor(value.document.id);
    expect(unchanged.punctuation).not.toBeNull();
    expect(unchanged.punctuation?.versionId).toBe(confirmedBefore);
    expect(value.repo.getLatestPunctuationSuggestion(value.document.id)).toMatchObject({
      messageId: prepared.messageId,
      responseText: rawResponse,
      validationState: "valid",
      applied: false,
    });

    const applied = value.repo.applyPunctuationSuggestionRun(prepared.messageId);
    expect(applied).toMatchObject({ validationState: "valid", applied: true });
    const after = counts(value.db);
    expect(after).toEqual({ ...before, punctuation: before.punctuation + 1 });
    const editor = value.repo.getEditor(value.document.id);
    expect(editor.punctuation).toMatchObject({
      versionId: applied.punctuationVersionId,
      state: "draft",
      punctuatedText: rawResponse,
      anchorSetId: null,
    });
    expect(editor.anchors).toEqual([]);
    const heads = value.db.prepare(
      `SELECT current_version_id, confirmed_version_id FROM punctuation_heads
       WHERE current_version_id = ?`,
    ).get(applied.punctuationVersionId) as { current_version_id: string; confirmed_version_id: string };
    expect(heads.confirmed_version_id).toBe(confirmedBefore);
    const origin = value.db.prepare(
      `SELECT actor.actor_kind, span.origin_kind
       FROM punctuation_versions version
       JOIN core_actors actor ON actor.id = version.created_by_actor_id
       JOIN punctuation_structure_spans span ON span.punctuation_version_id = version.id
       WHERE version.id = ? LIMIT 1`,
    ).get(applied.punctuationVersionId) as { actor_kind: string; origin_kind: string };
    expect(origin).toEqual({ actor_kind: "llm", origin_kind: "ai" });
    expect(value.repo.applyPunctuationSuggestionRun(prepared.messageId)).toEqual(applied);

    if (!editor.punctuation) throw new Error("expected the applied punctuation draft");
    const confirmed = value.repo.confirmPunctuation({
      documentNodeId: value.document.id,
      expectedLockVersion: editor.punctuation.lockVersion,
    });
    expect(confirmed.punctuation?.state).toBe("confirmed");
    expect(confirmed.punctuation?.anchorSetId).toBeTruthy();
    expect(confirmed.anchors.length).toBeGreaterThan(0);
  });

  it("applies an AI proposal as the first punctuation draft without creating anchors", () => {
    const value = setup();
    const root = value.repo.getHome().documents.find((item) => item.isMaster)!;
    const sourceOnly = value.repo.createDocument({
      title: "첫 AI 표점",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "學而時習之不亦說乎",
    });
    let editor = value.repo.getEditor(sourceOnly.id);
    editor = value.repo.confirmSource({
      documentNodeId: sourceOnly.id,
      expectedLockVersion: editor.source.lockVersion,
    });
    expect(editor.punctuation).toBeNull();
    const prepared = value.repo.beginPunctuationSuggestionRun({
      documentNodeId: sourceOnly.id,
      structureMode: "prose",
      agentId: "codex",
      requestedModel: "default",
      reasoningLevel: "medium",
      serviceTier: null,
      runtimeVersion: "codex-cli test",
    });
    value.repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId,
      rawResponse: "學而時習之，不亦說乎。",
      eventsJsonl: "",
      usage: null,
      resolvedModel: null,
      runtimeVersion: null,
    });
    const applied = value.repo.applyPunctuationSuggestionRun(prepared.messageId);
    expect(applied).toMatchObject({ applied: true, anchorSetId: null });
    const after = value.repo.getEditor(sourceOnly.id);
    expect(after.punctuation).toMatchObject({
      versionId: applied.punctuationVersionId,
      state: "draft",
      anchorSetId: null,
    });
    expect(after.anchors).toEqual([]);
  });

  it("rejects explicit apply when the captured punctuation head is stale", () => {
    const value = setup();
    const prepared = value.repo.beginPunctuationSuggestionRun({
      documentNodeId: value.document.id,
      structureMode: "prose",
      agentId: "codex",
      requestedModel: "default",
      reasoningLevel: "medium",
      serviceTier: null,
      runtimeVersion: "codex-cli test",
    });
    value.repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId,
      rawResponse: "天地玄黃，宇宙洪荒。",
      eventsJsonl: "",
      usage: null,
      resolvedModel: null,
      runtimeVersion: null,
    });
    const current = value.repo.getEditor(value.document.id);
    expect(current.punctuation).not.toBeNull();
    if (!current.punctuation) throw new Error("expected the current punctuation version");
    value.repo.savePunctuationDraft({
      documentNodeId: value.document.id,
      punctuatedText: "天地玄黃；宇宙洪荒。",
      structureMode: "prose",
      expectedLockVersion: current.punctuation.lockVersion,
    });
    const beforeApply = counts(value.db);
    expectMunhaeCode(() => value.repo.applyPunctuationSuggestionRun(prepared.messageId), "stale_request");
    expect(counts(value.db)).toEqual(beforeApply);
    expect(value.repo.getLatestPunctuationSuggestion(value.document.id)).toMatchObject({
      messageId: prepared.messageId,
      applied: false,
      punctuationVersionId: null,
    });
  });

  it("preserves an invalid provider response without applying a punctuation version", () => {
    const value = setup();
    const before = counts(value.db);
    const currentBefore = value.editor.punctuation.versionId;
    const prepared = value.repo.beginPunctuationSuggestionRun({
      documentNodeId: value.document.id,
      structureMode: "prose",
      agentId: "codex",
      requestedModel: "default",
      reasoningLevel: "medium",
      serviceTier: null,
      runtimeVersion: "codex-cli test",
    });
    const invalidResponse = "天地玄黃宇宙洪海";
    const completed = value.repo.completePunctuationSuggestionRun({
      messageId: prepared.messageId,
      rawResponse: invalidResponse,
      eventsJsonl: "",
      usage: null,
      resolvedModel: null,
      runtimeVersion: null,
    });
    expect(completed).toMatchObject({
      validationState: "invalid_unapplied",
      applied: false,
      punctuationVersionId: null,
    });
    expect(counts(value.db)).toEqual(before);
    const unchanged = value.repo.getEditor(value.document.id);
    expect(unchanged.punctuation).not.toBeNull();
    expect(unchanged.punctuation?.versionId).toBe(currentBefore);
    const stored = value.db.prepare(
      `SELECT m.output_validation_state, artifact.payload_text, part.text_content
       FROM chat_messages m
       JOIN provenance_artifacts artifact ON artifact.id = m.response_artifact_id
       JOIN chat_message_parts part ON part.message_id = m.id AND part.ordinal = 1
       WHERE m.id = ?`,
    ).get(prepared.messageId) as Record<string, unknown>;
    expect(stored).toMatchObject({
      output_validation_state: "invalid_unapplied",
      payload_text: invalidResponse,
      text_content: invalidResponse,
    });
  });
});
