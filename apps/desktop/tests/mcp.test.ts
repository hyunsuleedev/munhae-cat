import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectRepo } from "@munhae/db-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ repo: null as ProjectRepo | null, busy: { all: false, documentIds: new Set<string>() }, sent: [] as unknown[] }));
vi.mock("../src/main/session", () => ({
  getAppConfig: () => ({ translationLanguage: "ko" }),
  getCurrentSummary: () => state.repo
    ? { projectId: state.repo.projectId, title: state.repo.title, packagePath: state.repo.packagePath, storageMode: "local", openedAt: "" }
    : null,
  requireRepo: () => state.repo!,
  withOnlineProjectSave: async <T>(operation: () => T | Promise<T>): Promise<T> => await operation(),
}));
vi.mock("../src/main/ai-runs", () => ({ activeAiDocuments: () => state.busy }));
vi.mock("../src/main/security", () => ({ isAllowedNavigation: () => true }));
vi.mock("electron", () => ({ webContents: { getAllWebContents: () => [{ isDestroyed: () => false, getURL: () => "app://", send: (_channel: string, event: unknown) => state.sent.push(event) }] } }));

import { setEditingDocument, undoMcpChange } from "../src/main/mcp-changes";
import { callMcpTool } from "../src/main/mcp-handlers";
import { createMcpServer, McpToolError, type McpSession } from "../src/main/mcp-server";
import { MCP_APP_NOT_RUNNING, MCP_TOOLS } from "../src/shared/mcp-tools";

const relayPath = fileURLToPath(new URL("../out/main/mcp-relay.js", import.meta.url));
const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  state.repo?.close();
  state.repo = null;
});

async function start(callTool = vi.fn((name: string, args: Record<string, unknown>) => ({ name, args }))) {
  const server = createMcpServer({ callTool, version: "test", port: 0 });
  servers.push(server);
  const port = await server.listen();
  return { server, port, callTool };
}

async function rpc(port: number, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, session: response.headers.get("mcp-session-id"), body: text ? JSON.parse(text) : null };
}

const initialize = (id: number | string = 1, name = "claude-code") => ({
  jsonrpc: "2.0", id, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } },
});

describe("in-app MCP server", () => {
  it("negotiates a session, lists the shared tools and calls a tool with that session", async () => {
    const { server, port, callTool } = await start();
    const init = await rpc(port, initialize());
    expect(init.status).toBe(200);
    expect(init.session).toBeTruthy();
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "munhae" } });
    expect(init.body.result.instructions).toContain("다른 방법으로 접근하지 마세요");
    expect((await rpc(port, { jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": init.session! })).status).toBe(202);

    const list = await rpc(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": init.session! });
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(MCP_TOOLS.map(tool => tool.name));

    const call = await rpc(port, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_document", arguments: { projectId: "p", documentId: "d" } } }, { "mcp-session-id": init.session! });
    expect(JSON.parse(call.body.result.content[0].text)).toEqual({ name: "get_document", args: { projectId: "p", documentId: "d" } });
    expect(callTool.mock.calls[0]![2]).toMatchObject({ id: init.session, label: "Claude Code", via: "http" });
    expect(server.sessions.size).toBe(1);
  });

  it("returns tool failures as results the model reads, telling it to stop when it must", async () => {
    const { port } = await start(vi.fn((name: string) => {
      if (name === "get_terms") throw new McpToolError("document_busy", "문해에서 이 문서의 AI 작업이 진행 중입니다.", true);
      throw Object.assign(new Error("문서를 찾을 수 없습니다."), { code: "not_found" });
    }));
    const call = (name: string) => rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
    const busy = (await call("get_terms")).body.result;
    expect(busy.isError).toBe(true);
    expect(busy.content[0].text).toMatch(/^\[document_busy\] .*사용자에게 알리세요\.$/u);
    const missing = (await call("get_document")).body.result;
    expect(missing).toEqual({ isError: true, content: [{ type: "text", text: "[not_found] 문서를 찾을 수 없습니다." }] });
    expect((await call("drop_database")).body.error).toMatchObject({ code: -32602 });
    expect((await rpc(port, { jsonrpc: "2.0", id: 9, method: "resources/list" })).body.error).toMatchObject({ code: -32601 });
  });

  it("rejects browser pages, rebinding hosts, streams and malformed JSON", async () => {
    const { port } = await start();
    expect((await rpc(port, initialize(), { origin: "https://evil.example" })).status).toBe(403);
    const rebinding = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const call = request({ host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { host: "evil.example", "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        call.once("error", reject);
        call.end(JSON.stringify(initialize()));
      }, reject);
    });
    expect(rebinding).toBe(403);
    expect((await fetch(`http://127.0.0.1:${port}/mcp`)).status).toBe(405);
    expect((await rpc(port, "{not json")).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" })).status).toBe(404);
  });

  it("keeps working for a client whose session the app forgot after a restart", async () => {
    const { port, callTool } = await start();
    const call = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_open_project", arguments: {} } }, { "mcp-session-id": "from-before-restart" });
    expect(call.body.result.isError).toBeUndefined();
    expect(callTool.mock.calls[0]![2]).toMatchObject({ id: "from-before-restart", label: "AI 도구" });
  });
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/** Runs the built relay as AI tools do, feeding it JSON-RPC lines and collecting its answers. */
async function relay(port: number, messages: unknown[]): Promise<Array<Record<string, any>>> {
  await access(relayPath);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [relayPath], { env: { ...process.env, MUNHAE_MCP_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    child.once("error", reject);
    child.once("close", () => resolve(out.split("\n").filter(Boolean).map(line => JSON.parse(line))));
    child.stdin.end(messages.map(message => JSON.stringify(message)).join("\n") + "\n");
  });
}

describe("stdio relay", () => {
  it("lists the tools and asks for Munhae to be opened while the app is closed", async () => {
    const answers = await relay(await freePort(), [
      initialize(1, "codex-mcp-client"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_open_project", arguments: {} } },
    ]);
    expect(answers.map(answer => answer.id)).toEqual([1, 2, 3]);
    expect(answers[0]!.result.serverInfo.name).toBe("munhae");
    expect(answers[1]!.result.tools).toHaveLength(MCP_TOOLS.length);
    expect(answers[2]!.result).toEqual({ isError: true, content: [{ type: "text", text: MCP_APP_NOT_RUNNING }] });
  });

  it("forwards to the running app and labels the session by the AI tool", async () => {
    const { server, port, callTool } = await start();
    const answers = await relay(port, [
      initialize(1, "codex-mcp-client"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_terms", arguments: { projectId: "p", documentId: "d" } } },
    ]);
    expect(answers.map(answer => answer.id)).toEqual([1, 2]);
    expect(JSON.parse(answers[1]!.result.content[0].text)).toEqual({ name: "get_terms", args: { projectId: "p", documentId: "d" } });
    expect(callTool.mock.calls[0]![2]).toMatchObject({ label: "Codex", via: "relay" });
    // The relay closes its app session when the AI tool ends the conversation.
    expect(server.sessions.size).toBe(0);
  });

  it("connects later when Munhae opens after the AI tool started", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [relayPath], { env: { ...process.env, MUNHAE_MCP_PORT: String(port) }, stdio: ["pipe", "pipe", "pipe"] });
    const lines: Array<Record<string, any>> = [];
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) { lines.push(JSON.parse(buffer.slice(0, at))); buffer = buffer.slice(at + 1); }
    });
    const waitFor = async (count: number) => { const until = Date.now() + 5000; while (lines.length < count) { if (Date.now() > until) throw Error("relay did not answer"); await new Promise(r => setTimeout(r, 10)); } };
    child.stdin.write(JSON.stringify(initialize(1)) + "\n");
    await waitFor(1);
    const callTool = vi.fn(() => ({ ok: true }));
    const server = createMcpServer({ callTool, version: "test", port });
    servers.push(server);
    await server.listen();
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_open_project", arguments: {} } }) + "\n");
    await waitFor(2);
    child.stdin.end();
    expect(JSON.parse(lines[1]!.result.content[0].text)).toEqual({ ok: true });
    expect(callTool.mock.calls[0]![2]).toMatchObject({ label: "Claude Code", via: "relay" });
  });
});

const session: McpSession = { id: "s", label: "Claude Code", via: "relay", createdAt: "", lastSeenAt: "" };

describe.skipIf(!process.versions.electron)("read tools on a real project", () => {
  it("reads the open project, a document, its terms and translation guide, and refuses another project", async () => {
    const { seedDemoProject } = await import("@munhae/db-sqlite");
    const dir = await mkdtemp(join(tmpdir(), "munhae-mcp-"));
    try {
      state.repo = seedDemoProject(dir);
      const project = await callMcpTool("get_open_project", {}, session) as { projectId: string; documents: Array<{ id: string; kind: string; title: string }> };
      expect(project.projectId).toBe(state.repo.projectId);
      const doc = project.documents.find(item => item.kind === "source_unit")!;
      const args = { projectId: project.projectId, documentId: doc.id };
      const view = await callMcpTool("get_document", args, session) as { document: { id: string }; source: { text: string } };
      expect(view.document.id).toBe(doc.id);
      expect(view.source.text.length).toBeGreaterThan(0);
      expect(await callMcpTool("get_terms", args, session)).toMatchObject({ documentId: doc.id });
      expect((await callMcpTool("get_translation_guide", args, session) as { sections: Array<{ label: string }> }).sections.map(s => s.label)).toContain("번역 원칙");
      await expect(callMcpTool("get_document", { ...args, projectId: "other" }, session)).rejects.toMatchObject({ code: "project_changed", stop: true });
      await expect(callMcpTool("search_project", { projectId: project.projectId, query: "x", limit: 99 }, session)).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      state.repo?.close();
      state.repo = null;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!process.versions.electron)("write tools on a real project", () => {
  async function project() {
    const { createProject } = await import("@munhae/db-sqlite");
    const dir = await mkdtemp(join(tmpdir(), "munhae-mcp-write-"));
    const repo = createProject({ parentDir: dir, title: "MCP 쓰기" }).handle;
    state.repo = repo;
    const doc = repo.createDocument({ title: "관서악부서", parentId: null, nodeRole: "source_unit", sourceText: "王建宮詞𠮷王建", originKind: "paste" }).id;
    let editor = repo.confirmSource({ documentNodeId: doc, expectedLockVersion: repo.getEditor(doc).source.lockVersion });
    editor = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: doc, structureMode: "prose", expectedSourceLockVersion: editor.source.lockVersion });
    editor = repo.savePunctuationDraft({ documentNodeId: doc, punctuatedText: "王建，宮詞。𠮷王建。", structureMode: "prose", expectedLockVersion: editor.punctuation!.lockVersion });
    repo.confirmPunctuation({ documentNodeId: doc, expectedLockVersion: editor.punctuation!.lockVersion });
    const run = repo.beginFullTextRun({ documentNodeId: doc, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
    repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation: "왕건은 궁사를 지었다. 길한 왕건이다." }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
    return { repo, doc, dir, projectId: repo.projectId };
  }
  const call = (name: string, args: Record<string, unknown>, who: McpSession = session) => callMcpTool(name, args, who) as Promise<any>;

  it("adds, confirms and undoes terms, and edits, confirms and undoes the translation", async () => {
    const { repo, doc, dir, projectId } = await project();
    try {
      const args = { projectId, documentId: doc };
      const proposed = await call("propose_terms", { ...args, terms: [{ sourceForm: "王建", kind: "person", reading: "왕건", translation: "왕건" }, { sourceForm: "宮詞", kind: "work", occurrences: [1] }] });
      expect(proposed.candidateIds).toHaveLength(2);
      const terms = await call("get_terms", args);
      expect(terms.candidates.map((c: any) => [c.sourceForm, c.occurrences])).toEqual(expect.arrayContaining([["王建", 2], ["宮詞", 1]]));

      const confirmed = await call("confirm_terms", { ...args, candidates: terms.candidates.map((c: any) => ({ id: c.id })) });
      expect(confirmed.summary).toBe("용어 2개를 확정했습니다");
      expect((await call("get_terms", args)).terms).toHaveLength(2);
      // A failing batch changes nothing.
      await expect(call("confirm_terms", { ...args, candidates: [{ id: "missing" }] })).rejects.toMatchObject({ code: "not_found" });
      await undoMcpChange(confirmed.changeId);
      const back = await call("get_terms", args);
      expect(back.terms).toHaveLength(0);
      expect(back.candidates.map((c: any) => c.id).sort()).toEqual(terms.candidates.map((c: any) => c.id).sort());
      await expect(undoMcpChange(confirmed.changeId)).rejects.toMatchObject({ code: "already_undone" });

      const document = await call("get_document", args);
      const first = document.translation.sentences[0];
      const edited = await call("edit_translation_sentences", { ...args, revision: document.translation.revision, edits: [{ sentenceId: first.id, text: "왕건은 궁사를 남겼다." }] });
      expect((await call("get_document", args)).translation.text).toBe("왕건은 궁사를 남겼다. 길한 왕건이다.");
      await expect(call("edit_translation_sentences", { ...args, revision: document.translation.revision, edits: [{ sentenceId: first.id, text: "x" }] })).rejects.toMatchObject({ code: "stale_revision" });
      await undoMcpChange(edited.changeId);
      const restored = await call("get_document", args);
      expect(restored.translation.text).toBe(document.translation.text);

      const confirmedTranslation = await call("confirm_translation", { ...args, revision: restored.translation.revision });
      expect((await call("get_document", args)).translation.state).toBe("confirmed");
      await undoMcpChange(confirmedTranslation.changeId);
      expect((await call("get_document", args)).translation.state).toBe("draft");

      const comment = await call("add_comment", { ...args, on: "translation", quote: "왕건", occurrence: 2, body: "같은 인물인지 확인" });
      expect(repo.listReviewComments(doc).map(c => [c.quote, c.codepointFrom])).toEqual([["왕건", 16]]);
      // Only the conversation that made a change can undo it from the AI side.
      await expect(call("undo_change", { projectId, changeId: comment.changeId }, { ...session, id: "other" })).rejects.toMatchObject({ code: "not_found" });
      await call("undo_change", { projectId, changeId: comment.changeId });
      expect(repo.listReviewComments(doc)).toEqual([]);
      expect(state.sent.length).toBeGreaterThan(0);
    } finally {
      state.repo?.close(); state.repo = null;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a first translation and undoes it back to an empty draft, twice over", async () => {
    const { repo, dir, projectId } = await project();
    try {
      const doc = repo.createDocument({ title: "새 문서", parentId: null, nodeRole: "source_unit", sourceText: "王建詩", originKind: "paste" }).id;
      const args = { projectId, documentId: doc };
      const first = await call("replace_translation", { ...args, text: "왕건의 시." });
      await undoMcpChange(first.changeId);
      const empty = await call("get_document", args);
      expect(empty.translation).toMatchObject({ state: "draft", text: "" });
      // Writing into that empty draft again must also undo back to empty.
      const second = await call("replace_translation", { ...args, revision: empty.translation.revision, text: "왕건의 시다." });
      expect(second.summary).toBe("새 번역안을 썼습니다");
      await undoMcpChange(second.changeId);
      expect((await call("get_document", args)).translation.text).toBe("");
    } finally {
      state.repo?.close(); state.repo = null;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to write while the app works on the document or the user has unsaved edits there", async () => {
    const { doc, dir, projectId } = await project();
    try {
      const args = { projectId, documentId: doc, terms: [{ sourceForm: "王建", kind: "person" }] };
      state.busy = { all: false, documentIds: new Set([doc]) };
      await expect(call("propose_terms", args)).rejects.toMatchObject({ code: "document_busy", stop: true });
      state.busy = { all: false, documentIds: new Set() };
      setEditingDocument(doc);
      await expect(call("propose_terms", args)).rejects.toMatchObject({ code: "document_editing", stop: true });
      setEditingDocument(null);
      await expect(call("propose_terms", args)).resolves.toMatchObject({ summary: "용어 후보 1개를 더했습니다" });
    } finally {
      state.repo?.close(); state.repo = null;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
