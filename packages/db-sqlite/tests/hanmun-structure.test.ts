import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@munhae/domain";
import { createProject, openSqlite, type ProjectRepo } from "../src/index.ts";
import { prepareStructureSpans } from "../src/source-layer.ts";

const projects: { repo: ProjectRepo; directory: string }[] = [];
afterEach(() => {
  for (const { repo, directory } of projects.splice(0)) {
    repo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
function draft(mode: "prose" | "poetry", sourceText: string) {
  const directory = mkdtempSync(join(tmpdir(), "munhae-structure-"));
  const { handle: repo } = createProject({ title: "분할 검증", parentDir: directory });
  projects.push({ repo, directory });
  const document = repo.createDocument({ title: "본문", parentId: null, nodeRole: "source_unit", originKind: "paste", sourceText });
  let view = repo.getEditor(document.id);
  view = repo.confirmSource({ documentNodeId: document.id, expectedLockVersion: view.source.lockVersion });
  view = repo.createPunctuationDraftFromConfirmedSource({ documentNodeId: document.id, structureMode: mode, expectedSourceLockVersion: view.source.lockVersion });
  return { repo, document, view };
}

describe("versioned punctuation structure", () => {
  it.each(["prose", "poetry"] as const)("saves %s ranges, confirms whitespace gaps, and preserves historical ranges after merging", mode => {
    const { repo, document, view } = draft(mode, "𠮷甲 \n 乙丙\n 丁戊");
    const text = " \t𠮷甲。\n乙丙！\n\n丁戊。 \n";
    let saved = repo.savePunctuationDraft({ documentNodeId: document.id, punctuatedText: text, structureMode: mode, expectedLockVersion: view.punctuation!.lockVersion });
    expect(saved.punctuation!.punctuatedText).toBe(text);
    const originalSpans = saved.punctuation!.structureSpans;
    expect(originalSpans.filter(span => span.spanKind === "paragraph")).toHaveLength(mode === "poetry" ? 2 : 3);
    const leaves = originalSpans.filter(span => span.spanKind === (mode === "poetry" ? "verse_line" : "sentence"));
    expect(leaves.map(span => span.quote)).toEqual(["𠮷甲。", "乙丙！", "丁戊。"]);
    for (const span of originalSpans) {
      expect(span.quote).toBe(Array.from(text).slice(span.codepointFrom, span.codepointTo).join(""));
      expect(span.quote).toBe(span.quote.trim());
    }
    saved = repo.confirmPunctuation({ documentNodeId: document.id, expectedLockVersion: saved.punctuation!.lockVersion });
    expect(saved.anchors.map(anchor => anchor.punctuatedQuote)).toEqual(leaves.map(span => span.quote));
    const oldVersion = saved.punctuation!.versionId;
    const oldAnchorSet = saved.punctuation!.anchorSetId;
    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      expect(db.prepare("SELECT coverage_policy, strategy_version FROM translation_anchor_sets WHERE id = ?").get(oldAnchorSet))
        .toEqual({ coverage_policy: "non_whitespace", strategy_version: 2 });
      const oldRows = db.prepare("SELECT * FROM punctuation_structure_spans WHERE punctuation_version_id = ? ORDER BY id").all(oldVersion);
      for (const row of oldRows as Array<{ quote: string; quote_hash: string }>) {
        expect(row.quote_hash).toBe(sha256Hex(row.quote));
      }
      const oldAnchors = db.prepare("SELECT * FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal").all(oldAnchorSet);
      expect(oldAnchors.map(row => (row as { source_quote: string }).source_quote)).toEqual(["𠮷甲", "乙丙", "丁戊"]);
      const merged = mode === "poetry" ? text.replace("\n\n", "\n") : text.replace(/\n/g, "");
      let edited = repo.savePunctuationDraft({ documentNodeId: document.id, punctuatedText: merged, structureMode: mode, expectedLockVersion: saved.punctuation!.lockVersion });
      expect(edited.punctuation!.structureSpans.filter(span => span.spanKind === "paragraph")).toHaveLength(1);
      expect(edited.punctuation!.structureSpans.filter(span => span.spanKind !== "paragraph")).toHaveLength(3);
      edited = repo.confirmPunctuation({ documentNodeId: document.id, expectedLockVersion: edited.punctuation!.lockVersion });
      expect(edited.anchors).toHaveLength(3);
      expect(repo.getEditor(document.id).punctuation!.structureSpans).toEqual(edited.punctuation!.structureSpans);
      expect(db.prepare("SELECT * FROM punctuation_structure_spans WHERE punctuation_version_id = ? ORDER BY id").all(oldVersion)).toEqual(oldRows);
      expect(db.prepare("SELECT * FROM translation_anchors WHERE anchor_set_id = ? ORDER BY ordinal").all(oldAnchorSet)).toEqual(oldAnchors);
    } finally { db.close(); }
  });

  it("confirms an existing whitespace-inclusive version using its original rules", () => {
    const { repo, document, view } = draft("prose", "甲乙");
    const text = "甲。\n\n乙。\n";
    const saved = repo.savePunctuationDraft({ documentNodeId: document.id, punctuatedText: text, structureMode: "prose", expectedLockVersion: view.punctuation!.lockVersion });
    const db = openSqlite(join(repo.packagePath, "project.sqlite3"));
    try {
      const legacy = prepareStructureSpans(text, "prose", undefined, 1);
      const current = saved.punctuation!.structureSpans;
      // Model a pre-upgrade DB version with its existing IDs and whitespace-owning ranges.
      expect(legacy).toHaveLength(current.length);
      for (const span of legacy) {
        const corresponding = current.find(row => row.spanKind === span.spanKind &&
          (span.spanKind === "paragraph" ? row.ordinal === span.ordinal : row.codepointFrom === span.codepointFrom));
        expect(corresponding).toBeDefined();
        db.prepare("UPDATE punctuation_structure_spans SET codepoint_from = ?, codepoint_to = ?, quote = ?, quote_hash = ? WHERE id = ?")
          .run(span.codepointFrom, span.codepointTo, span.quote, span.quoteHash, corresponding!.id);
      }
      db.prepare("UPDATE punctuation_versions SET structure_json = ? WHERE id = ?").run(JSON.stringify({ mode: "prose" }), saved.punctuation!.versionId);
      const confirmed = repo.confirmPunctuation({ documentNodeId: document.id, expectedLockVersion: saved.punctuation!.lockVersion });
      expect(confirmed.anchors.map(anchor => anchor.punctuatedQuote)).toEqual(["甲。\n\n", "乙。\n"]);
      expect(db.prepare("SELECT coverage_policy, strategy_version FROM translation_anchor_sets WHERE id = ?").get(confirmed.punctuation!.anchorSetId))
        .toEqual({ coverage_policy: "full_text", strategy_version: 1 });
    } finally { db.close(); }
  });

  it("rejects non-whitespace omissions and overlapping ranges", () => {
    const valid = prepareStructureSpans("甲。 乙。", "prose");
    expect(() => prepareStructureSpans("甲。 乙。", "prose", valid.filter(span => span.quote !== "乙。"))).toThrow(/누락/);
    const overlapping = valid.map(span => span.quote === "乙。" ? { ...span, codepointFrom: 0 } : span);
    expect(() => prepareStructureSpans("甲。 乙。", "prose", overlapping)).toThrow(/겹치/);
    const legacyPoetry = prepareStructureSpans("甲\n乙\n\n丙\n丁", "poetry", undefined, 1);
    expect(legacyPoetry.filter(span => span.spanKind === "couplet")).toHaveLength(2);
  });
});
