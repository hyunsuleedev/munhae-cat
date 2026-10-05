import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createProject } from "../src/project-repo.ts";

const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });

it("creates a document before its source text and fills the empty draft in place", () => {
  const parentDir = mkdtempSync(join(tmpdir(), "munhae-empty-source-"));
  cleanup.push(() => rmSync(parentDir, { recursive: true, force: true }));
  const repo = createProject({ title: "빈 원문", parentDir }).handle;
  cleanup.push(() => repo.close());

  const document = repo.createDocument({ title: "서문", nodeRole: "source_unit", sourceText: "", originKind: "manual", parentId: null });
  let editor = repo.getEditor(document.id);
  expect(editor.source).toMatchObject({ contentText: "", state: "draft", versionNo: 1 });
  expect(() => repo.confirmSource({ documentNodeId: document.id, expectedLockVersion: editor.source.lockVersion }))
    .toThrow("원문이 비어 있습니다");

  editor = repo.saveSourceDraft({ documentNodeId: document.id, contentText: "天地玄黃", originKind: "paste", expectedLockVersion: editor.source.lockVersion });
  expect(editor.source).toMatchObject({ contentText: "天地玄黃", state: "draft", versionNo: 1 });
  expect(() => repo.saveSourceDraft({ documentNodeId: document.id, contentText: "宇宙洪荒", originKind: "manual", expectedLockVersion: editor.source.lockVersion - 1 }))
    .toThrow();

  editor = repo.saveSourceDraft({ documentNodeId: document.id, contentText: "宇宙洪荒", originKind: "manual", expectedLockVersion: editor.source.lockVersion });
  expect(editor.source).toMatchObject({ contentText: "宇宙洪荒", versionNo: 2 });
  editor = repo.confirmSource({ documentNodeId: document.id, expectedLockVersion: editor.source.lockVersion });
  expect(editor.source.state).toBe("confirmed");
});
