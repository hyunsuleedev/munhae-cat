import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonHash, MunhaeError } from "@munhae/domain";
import {
  compareDocumentVersions,
  createConfirmedExport,
  loadDocumentHistory,
  openSqlite,
  searchProject,
  seedDemoProject,
  type ProjectRepo,
  type SqliteDb,
} from "../src/index.ts";

const dirs: string[] = [];
const repos: ProjectRepo[] = [];
const dbs: SqliteDb[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "munhae-history-"));
  dirs.push(dir);
  return dir;
}

function setup(): { repo: ProjectRepo; db: SqliteDb; documentNodeId: string } {
  const repo = seedDemoProject(tempDir());
  repos.push(repo);
  const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
  dbs.push(db);
  const documentNodeId = repo.getHome().documents.find((item) => item.originalTitle === "御製序")!.id;
  return { repo, db, documentNodeId };
}

afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
  while (repos.length) {
    try {
      repos.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("version history and lineage-bound diff", () => {
  it("returns exact source, punctuation, and translation version detail", () => {
    const { db, repo, documentNodeId } = setup();
    const editor = repo.getEditor(documentNodeId);
    repo.saveSourceDraft({
      documentNodeId,
      contentText: `${editor.source.contentText}天地`,
      originKind: "manual",
      changeSummary: "시험 변경",
      expectedLockVersion: editor.source.lockVersion,
    });

    const history = loadDocumentHistory(db, repo.projectId, documentNodeId);
    const sources = history.entries.filter((entry) => entry.kind === "source");
    const punctuation = history.entries.filter((entry) => entry.kind === "punctuation");
    const translation = history.entries.filter((entry) => entry.kind === "translation" && entry.stage === "translation");

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ versionNo: 2, isCurrent: true, changeSummary: "시험 변경" });
    expect(sources[0]!.parentVersionId).toBe(sources[1]!.versionId);
    expect(sources.every((entry) => /^[a-f0-9]{64}$/.test(entry.contentHash))).toBe(true);
    expect(punctuation[0]).toMatchObject({ anchorSetId: expect.any(String), structureSpanCount: expect.any(Number) });
    expect(translation).toHaveLength(2);
    expect(translation[0]!.blocks[0]).toMatchObject({
      blockKey: "b1",
      targetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      anchors: expect.arrayContaining([expect.objectContaining({
        anchorId: expect.any(String),
        anchorKey: "A001",
        sourceQuoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        punctuatedQuoteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })]),
    });
  });

  it("compares only two versions from the single translation lineage", () => {
    const { db, repo, documentNodeId } = setup();
    const history = loadDocumentHistory(db, repo.projectId, documentNodeId);
    const translation = history.entries
      .filter((entry) => entry.kind === "translation" && entry.stage === "translation")
      .sort((a, b) => a.versionNo - b.versionNo);

    const diff = compareDocumentVersions(db, repo.projectId, {
      documentNodeId,
      kind: "translation",
      stage: "translation",
      baseVersionId: translation[0]!.versionId,
      targetVersionId: translation[1]!.versionId,
    });
    expect(diff.aggregateId).toBe(translation[0]!.aggregateId);
    expect(diff.stage).toBe("translation");
    expect(translation[0]!.contentText).not.toBe(translation[1]!.contentText);
    expect(diff.chunks).toContainEqual(expect.objectContaining({ type: "remove" }));
  });
});

describe("confirmed-only export", () => {
  it("blocks drafts and exports exact confirmed versions, hashes, anchors, and blocks", () => {
    const { db, repo, documentNodeId } = setup();
    expect(() =>
      createConfirmedExport(db, repo.projectId, { format: "json", documentNodeId }),
    ).toThrowError(MunhaeError);

    const current = repo.getEditor(documentNodeId).translation!;
    repo.confirmTranslation({
      documentNodeId,
      expectedLockVersion: current.lockVersion,
    });

    const json = createConfirmedExport(db, repo.projectId, { format: "json", documentNodeId });
    const parsed = JSON.parse(json.content) as {
      schema: string;
      manifestHash: string;
      documents: Array<{ stage: string; confirmedTranslation: { versionId: string }; blocks: Array<{ anchors: unknown[] }> }>;
    };
    expect(json.confirmedTranslationCount).toBe(1);
    expect(parsed.schema).toBe("munhae-confirmed-export.v1");
    expect(parsed.manifestHash).toBe(json.manifestHash);
    expect(parsed.documents).toHaveLength(1);
    expect(parsed.documents[0]).toMatchObject({ stage: "translation" });
    expect(parsed.documents[0]!.confirmedTranslation.versionId).toBe(current.versionId);
    expect(parsed.documents[0]!.blocks[0]!.anchors.length).toBeGreaterThan(0);

    const markdown = createConfirmedExport(db, repo.projectId, { format: "markdown", documentNodeId });
    expect(markdown.content).toContain("exact version / SHA-256");
    expect(markdown.content).toContain("A001");
    expect(markdown.content).not.toContain("우리나라 말은 중국");

    const csv = createConfirmedExport(db, repo.projectId, { format: "csv", documentNodeId });
    expect(csv.content.startsWith("\uFEFF")).toBe(true);
    expect(csv.content).toContain('"translation_version_id"');
    expect(csv.content).toContain('"anchor_keys"');
    expect(csv.content).toContain('"anchors_json"');
  });
});

describe("rebuildable exact and FTS search", () => {
  it("finds source and Korean translation versions with scope and state filters", () => {
    const { db, repo, documentNodeId } = setup();
    const source = searchProject(db, repo.projectId, {
      query: "國之語音",
      scope: "source",
      state: "current",
    });
    expect(source.rebuiltFromLedger).toBe(true);
    expect(source.results).toEqual([
      expect.objectContaining({ resultKind: "source", documentNodeId, matchKind: "exact", isCurrent: true }),
    ]);

    const translation = searchProject(db, repo.projectId, {
      query: "가엾게",
      scope: "translation",
      state: "all",
    });
    expect(translation.results.some((result) => result.resultKind === "translation" && result.snippet.includes("가엾게"))).toBe(true);

    const confirmedOnly = searchProject(db, repo.projectId, {
      query: "가엾게",
      scope: "translation",
      state: "confirmed",
    });
    expect(confirmedOnly.results).toEqual([]);

    const knowledge = repo.getKnowledge();
    const term = knowledge.glossary.find((entry) => entry.sourceTerm === "文字")!;
    const entityFiltered = searchProject(db, repo.projectId, {
      query: "國之語",
      scope: "source",
      state: "current",
      entityFilter: { entityType: "glossary", entityId: term.id },
    });
    expect(entityFiltered.entityFilter).toMatchObject({
      entityType: "glossary",
      entityId: term.id,
      label: `${term.sourceTerm} → ${term.targetTerm}`,
      terms: expect.arrayContaining([term.sourceTerm, term.targetTerm]),
    });
    expect(entityFiltered.results).toEqual([
      expect.objectContaining({ resultKind: "source", documentNodeId }),
    ]);

    const unrelatedTerm = knowledge.glossary.find((entry) => entry.sourceTerm === "集賢殿")!;
    const excludedByEntity = searchProject(db, repo.projectId, {
      query: "國之語",
      scope: "source",
      state: "current",
      entityFilter: { entityType: "glossary", entityId: unrelatedTerm.id },
    });
    expect(excludedByEntity.results).toEqual([]);
    expect(() => searchProject(db, repo.projectId, {
      query: "國之語",
      entityFilter: { entityType: "person" as never, entityId: term.id },
    })).toThrowError(MunhaeError);

    const shortHan = searchProject(db, repo.projectId, {
      query: "國",
      scope: "source",
      state: "current",
    });
    expect(shortHan.usedShortHanPrefix).toBe(true);
    expect(shortHan.results).toContainEqual(expect.objectContaining({
      documentNodeId,
      matchKind: "prefix",
    }));
  });
});

describe("knowledge entity hashes and optimistic locks", () => {
  it("hashes every persisted glossary content field and rejects stale updates", () => {
    const { repo } = setup();
    const initial = repo.getKnowledge();
    const glossary = initial.glossary[0]!;

    expect(glossary.contentHash).toBe(canonicalJsonHash({
      sourceTerm: glossary.sourceTerm,
      targetTerm: glossary.targetTerm,
      targetLocale: glossary.targetLocale,
      termKind: glossary.termKind,
      reading: glossary.reading,
      noteMd: glossary.noteMd,
      usageStatus: glossary.usageStatus,
    }));
    const glossaryUpdated = repo.upsertGlossary({
      id: glossary.id,
      expectedLockVersion: glossary.lockVersion,
      sourceTerm: glossary.sourceTerm,
      targetTerm: glossary.targetTerm,
      targetLocale: glossary.targetLocale,
      termKind: glossary.termKind,
      reading: glossary.reading,
      noteMd: `${glossary.noteMd ?? ""} 변경`,
      usageStatus: glossary.usageStatus,
    });
    expect(glossaryUpdated).toMatchObject({ lockVersion: glossary.lockVersion + 1 });
    expect(glossaryUpdated.contentHash).not.toBe(glossary.contentHash);
    expect(() => repo.upsertGlossary({
      id: glossary.id,
      expectedLockVersion: glossary.lockVersion,
      sourceTerm: glossary.sourceTerm,
      targetTerm: glossary.targetTerm,
      targetLocale: glossary.targetLocale,
      termKind: glossary.termKind,
      reading: glossary.reading,
      noteMd: glossary.noteMd,
      usageStatus: glossary.usageStatus,
    })).toThrowError(MunhaeError);

  });
});
