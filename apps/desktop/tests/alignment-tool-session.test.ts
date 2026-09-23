import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProject, type ProjectRepo } from "@munhae/db-sqlite";
import { afterEach, expect, it } from "vitest";
import { createAlignmentToolSession } from "../src/main/alignment-tool-session";
import { createTranslationToolGrant, stopAgentToolBridge, type TranslationToolGrant } from "../src/main/agent-tool-bridge";

const repos: ProjectRepo[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await stopAgentToolBridge();
  while (repos.length) repos.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
async function cli(grant: TranslationToolGrant, command: string, body: unknown) {
  return new Promise<{ code: number | null; body: any }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../out/main/agent-tool-cli.js", import.meta.url)), "tools", command], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MUNHAE_TOOL_URL: grant.endpoint, MUNHAE_TOOL_GRANT: grant.token,
        MUNHAE_TOOL_RUN_ID: grant.runId, MUNHAE_TOOL_COMMAND: "submit-alignment" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.once("error", reject);
    child.once("close", code => {
      try { resolve({ code, body: JSON.parse(stdout) }); } catch { reject(new Error(stderr || stdout)); }
    });
    child.stdin.end(JSON.stringify(body));
  });
}

it.skipIf(!process.versions.electron)("repairs the Ananda tail misalignment through CLI input, check, repair and explicit finish", async () => {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-alignment-tools-")); dirs.push(parentDir);
  const repo = createProject({ title: "연결 도구 검증", parentDir }).handle; repos.push(repo);
  const source = "阿難墯淫室三旬不返世尊救拔苦海樊巖定力吾未知與阿難何如僕無世尊神通亦安知其不爲淸凈大法乎請樊巖以吾詩爲禪家數珠問主人翁惺惺否也";
  const doc = repo.createDocument({ title: "아난 이후 대응", nodeRole: "source_unit", sourceText: source, originKind: "paste", parentId: null });
  let e = repo.getEditor(doc.id);
  e = repo.confirmSource({ documentNodeId: doc.id, expectedLockVersion: e.source.lockVersion });
  e = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: doc.id, expectedSourceLockVersion: e.source.lockVersion, structureMode: "prose" });
  e = repo.savePunctuationDraft({ documentNodeId: doc.id, expectedLockVersion: e.punctuation!.lockVersion, structureMode: "prose", punctuatedText: "阿難墯淫室，三旬不返，世尊救拔苦海。樊巖定力，吾未知與阿難何如。僕無世尊神通，亦安知其不爲淸凈大法乎。請樊巖以吾詩，爲禪家數珠，問主人翁惺惺否也。" });
  e = repo.confirmPunctuation({ documentNodeId: doc.id, expectedLockVersion: e.punctuation!.lockVersion });
  const punctuationVersionId = e.punctuation!.versionId;
  const run = repo.beginFullTextRun({ documentNodeId: doc.id, agentId: "codex", requestedModel: null, reasoningLevel: null, serviceTier: null, runtimeVersion: null });
  const translation = "아난이 삼십 일 돌아오지 않았다. 세존이 고해에서 구했다. 번암의 정력이 아난과 어떠한지 모른다. 나에게는 세존의 신통이 없다. 청정대법이 아니라고 어찌 알겠는가? 내 시를 염주로 삼아 깨어 있는가? 하고 물으시라.";
  const { version } = repo.completeFullTextRun({ messageId: run.messageId, rawResponse: JSON.stringify({ schemaVersion: 1, translation }), eventsJsonl: "", usage: null, resolvedModel: null, runtimeVersion: null });
  const versionId = version.versionId;
  repo.prepareAlignment(versionId);
  const handler = createAlignmentToolSession(repo, versionId);
  const grant = await createTranslationToolGrant({ projectId: repo.projectId, runId: run.messageId, onSubmit() { throw Error("wrong mode"); }, onAlignment: handler });
  const input = (links: unknown[]) => ({ schemaVersion: 3, versionId, punctuationVersionId, links });
  const group = (sentenceIds: string[], n: number) => ({ sentenceIds, ranges: [{ start: `a${n}`, end: `a${n + 1}` }], needsReview: false });
  // Matches the observed failure: a two-target source unit is assigned only
  // its first target; following groups shift and the last two targets remain.
  expect((await cli(grant, "submit-alignment", input([group(["T1"], 1), group(["T2"], 2), group(["T3"], 3), group(["T4", "T5"], 4)]))).code).toBe(0);
  expect(grant.inspect().committed).toBe(false);
  expect((await cli(grant, "finish-alignment", { revision: "unchecked", outcome: "complete" })).body.error).toBe("check_required");
  const check = (await cli(grant, "check-alignment", {})).body;
  expect(check.issues.map((issue: any) => issue.sentenceId)).toEqual(["T6", "T7"]);
  expect(check.warnings).toHaveLength(1);
  expect(check.sentences[0].link.spans[0].quote).toContain("世尊救拔苦海");
  expect((await cli(grant, "finish-alignment", { revision: check.revision, outcome: "complete" })).code).toBe(1);
  // A rejected partial split changes nothing and remains retryable.
  expect((await cli(grant, "submit-alignment", input([group(["T4"], 3)]))).body.message).toContain("T5");
  expect((await cli(grant, "submit-alignment", input([group(["T1", "T2"], 1), group(["T3"], 2), group(["T4", "T5"], 3), group(["T6", "T7"], 4)]))).code).toBe(0);
  expect((await cli(grant, "finish-alignment", { revision: check.revision, outcome: "complete" })).body.error).toBe("check_required");
  const fixed = (await cli(grant, "check-alignment", {})).body;
  expect(fixed.issues).toEqual([]);
  expect((await cli(grant, "finish-alignment", { revision: fixed.revision, outcome: "complete" })).body.state).toBe("ready");
  expect(grant.inspect().committed).toBe(true);
  expect((await cli(grant, "check-alignment", {})).body.error).toBe("already_finished");
  expect(repo.getEditor(doc.id).translation!.textContent).toBe(translation);
  expect(repo.getEditor(doc.id).translation!.textLayout!.links[1]!.spans[0]!.quote).toContain("世尊救拔苦海");
});
