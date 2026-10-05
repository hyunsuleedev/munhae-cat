import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject, openProject } from "../src/project-repo.ts";
import { parseTranslationSkill } from "../src/translation-skill.ts";
import { BUNDLED_SKILLS } from "../src/bundled-skills.ts";

const clean: Array<() => void> = [];
afterEach(() => {
  while (clean.length) clean.pop()!();
});

const GUIDE = `---
name: sillok-style
version: 0.2.0
description: 실록 문체 번역 지침
---
관직명은 원문 표기를 유지하고 처음 나올 때 괄호로 풀이한다.
`;

function setup() {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-skill-"));
  clean.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "번역 플러그인", parentDir }).handle;
  const doc = repo.createDocument({ title: "원문", nodeRole: "source_unit", sourceText: "學而時習之不亦說乎", originKind: "paste", parentId: null });
  return { repo, id: doc.id };
}

it("parses standard SKILL.md frontmatter and rejects unusable plugins", () => {
  const skill = parseTranslationSkill(`﻿${GUIDE.replaceAll("\n", "\r\n")}`);
  expect(skill).toMatchObject({ name: "sillok-style", version: "0.2.0", description: "실록 문체 번역 지침" });
  expect(skill.content).toBe(GUIDE);
  expect(parseTranslationSkill("---\nname: folded\ndescription: >\n  두 줄로\n  쓴 설명\nmetadata:\n  owner: me\n---\n본문\n"))
    .toMatchObject({ description: "두 줄로 쓴 설명", version: null });
  expect(() => parseTranslationSkill("본문만 있음")).toThrow(/name과 description/);
  expect(() => parseTranslationSkill(GUIDE.replace("sillok-style", "Sillok Style"))).toThrow(/name/);
  expect(() => parseTranslationSkill(GUIDE.replace("sillok-style", "translate-document"))).toThrow(/기본 스킬/);
  expect(() => parseTranslationSkill("---\nname: empty\ndescription: 없음\n---\n  \n")).toThrow(/본문/);
  expect(() => parseTranslationSkill(GUIDE + "가".repeat(60_000))).toThrow(/60,000/);
});

it("replaces only the translation method and keeps the app submission rules", () => {
  const { repo, id } = setup();
  clean.push(() => repo.close());
  expect(repo.getTranslationSkill()).toBeNull();
  const base = repo.previewContext({ documentNodeId: id });
  expect(base.required.find((item) => item.kind === "translation_skill")).toMatchObject({ label: "기본 번역 스킬", version: "1.3.0" });

  const applied = repo.setTranslationSkill(GUIDE)!;
  const preview = repo.previewContext({ documentNodeId: id });
  const method = preview.required.find((item) => item.kind === "translation_skill")!;
  expect(method).toMatchObject({ label: "번역 플러그인 · sillok-style", version: "0.2.0", hash: applied.hash, content: GUIDE });
  expect(preview.requestText).toContain("관직명은 원문 표기를 유지");
  expect(preview.requestText).not.toContain(BUNDLED_SKILLS["translate-document"]);
  expect(preview.requestText).toContain("Submission rules (fixed by the app");
  expect(preview.required.some((item) => item.kind === "output_contract")).toBe(true);
  expect(JSON.parse(preview.manifestJson).skills.map((s: { name: string }) => s.name)).toEqual(["sillok-style", "align-translation"]);
  expect(preview.manifestHash).not.toBe(base.manifestHash);

  expect(repo.setTranslationSkill(null)).toBeNull();
  expect(repo.previewContext({ documentNodeId: id }).requestText).toBe(base.requestText);
});

it("stores the exact plugin text in the project so it survives reopening", () => {
  const { repo, id } = setup();
  repo.setTranslationSkill(GUIDE);
  repo.close();
  const reopened = openProject(repo.packagePath);
  clean.push(() => reopened.close());
  expect(reopened.getTranslationSkill()?.content).toBe(GUIDE);
  expect(reopened.previewContext({ documentNodeId: id }).requestText).toContain("관직명은 원문 표기를 유지");
});
