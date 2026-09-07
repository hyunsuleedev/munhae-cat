import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MunhaeError } from "@munhae/domain";
import { createProject, seedDemoProject, type ProjectRepo } from "../src/index.ts";

const dirs: string[] = [];
const repos: ProjectRepo[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "munhae-knowledge-"));
  dirs.push(dir);
  return dir;
}

function track(repo: ProjectRepo): ProjectRepo {
  repos.push(repo);
  return repo;
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(MunhaeError);
    expect((error as MunhaeError).code).toBe(code);
  }
}

afterEach(() => {
  while (repos.length > 0) {
    try {
      repos.pop()?.close();
    } catch {
      // already closed
    }
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("document metadata and context cards", () => {
  it("updates metadata with CAS and inherits only the designated parent fields", () => {
    const repo = track(createProject({ title: "문서 정보", parentDir: tempDir() }).handle);
    const root = repo.getHome().documents.find((item) => item.isMaster)!;
    const person = repo.upsertPerson({
      preferredName: "허균",
      hanjaName: "許筠",
      reading: "허균",
      aliases: [],
      descriptionMd: null,
      dateText: "1569–1618",
    });
    const rootMetadata = repo.getDocumentMetadata(root.id);
    const updatedRoot = repo.updateDocumentMetadata({
      documentNodeId: root.id,
      title: rootMetadata.title,
      originalTitle: "文解集",
      authorPersonId: person.id,
      language: "lzh",
      periodText: "조선 중기",
      dateText: "1446",
      descriptionMd: "프로젝트 공통 설명",
      sourceReference: "소장본 A",
      expectedLockVersion: rootMetadata.lockVersion,
    });
    expect(updatedRoot.lockVersion).toBe(rootMetadata.lockVersion + 1);

    const child = repo.createDocument({
      title: "서문",
      originalTitle: "序",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃。",
    });
    const editor = repo.getEditor(child.id);
    expect(editor.document).toMatchObject({
      authorName: "허균",
      language: "lzh",
      periodText: "조선 중기",
      dateText: null,
      sourceReference: "소장본 A",
    });

    expectCode(
      () => repo.updateDocumentMetadata({ ...updatedRoot, documentNodeId: root.id, expectedLockVersion: rootMetadata.lockVersion }),
      "cas_conflict",
    );
  });

  it("creates, edits, toggles, reprioritizes, and archives context cards with CAS", () => {
    const repo = track(createProject({ title: "문맥", parentDir: tempDir() }).handle);
    const root = repo.getHome().documents.find((item) => item.isMaster)!;
    const child = repo.createDocument({
      title: "원문",
      parentId: root.id,
      nodeRole: "source_unit",
      originKind: "paste",
      sourceText: "天地玄黃。",
    });
    let editor = repo.getEditor(child.id);
    editor = repo.confirmSource({
      documentNodeId: child.id,
      expectedLockVersion: editor.source.lockVersion,
    });
    editor = repo.createPunctuationDraftFromConfirmedSource({
      documentNodeId: child.id,
      structureMode: "prose",
      expectedSourceLockVersion: editor.source.lockVersion,
    });
    if (!editor.punctuation) throw new Error("expected punctuation draft");
    editor = repo.confirmPunctuation({
      documentNodeId: child.id,
      expectedLockVersion: editor.punctuation.lockVersion,
    });
    expect(editor.punctuation?.state).toBe("confirmed");
    expect(editor.anchors.length).toBeGreaterThan(0);
    const ancestor = repo.createContextItem({
      scopeId: root.id,

      title: "공통 문맥",
      contentMd: "프로젝트 전체 문맥",
      priority: 999,
      enabled: true,
    });
    const direct = repo.createContextItem({
      scopeId: child.id,

      title: "현재 문서",
      contentMd: "현재 문서 문맥",
      priority: -10,
      enabled: true,
    });
    const order = repo.previewContext({ documentNodeId: child.id }).auxiliary
      .filter((item) => item.kind === "context_item")
      .map((item) => item.id);
    expect(order).toEqual([direct.id, ancestor.id]);

    const edited = repo.updateContextItem({
      id: direct.id,
      scopeId: child.id,

      title: "근거",
      contentMd: "교감 근거",
      priority: 4,
      enabled: true,
      expectedLockVersion: direct.lockVersion,
    });
    const disabled = repo.setContextItemEnabled({
      id: edited.id,
      enabled: false,
      expectedLockVersion: edited.lockVersion,
    });
    expect(disabled.enabled).toBe(false);
    expect(
      repo.previewContext({ documentNodeId: child.id }).auxiliary.find((item) => item.id === direct.id),
    ).toMatchObject({ included: false, defaultIncluded: false });
    expectCode(
      () => repo.setContextItemPriority({ id: direct.id, priority: 8, expectedLockVersion: edited.lockVersion }),
      "cas_conflict",
    );
    const prioritized = repo.setContextItemPriority({
      id: disabled.id,
      priority: 8,
      expectedLockVersion: disabled.lockVersion,
    });
    repo.archiveContextItem({ id: prioritized.id, expectedLockVersion: prioritized.lockVersion });
    expect(repo.getKnowledge().contextItems.some((item) => item.id === direct.id)).toBe(false);
    expectCode(
      () => repo.archiveContextItem({ id: ancestor.id, expectedLockVersion: ancestor.lockVersion + 1 }),
      "cas_conflict",
    );
  });
});

describe("uncertainty workflow", () => {
  it("versions options and anchors, then blocks confirmation until the current issue is resolved", () => {
    const repo = track(seedDemoProject(tempDir()));
    const document = repo.getHome().documents.find((item) => item.originalTitle === "御製序")!;
    const editor = repo.getEditor(document.id);
    const translation = editor.translation!;
    const initialUncertaintyCount = repo.getHome().documents.find(
      (item) => item.id === document.id,
    )!.uncertaintyCount;
    const created = repo.createUncertainty({
      category: "textual",
      severity: "major",
      blocking: true,
      statementMd: "첫 글자의 판독을 확인해야 한다.",
      rationaleMd: "이본 대조 전에는 확정할 수 없다.",
      confidenceLabel: "low",
      options: [
        { label: "天", interpretationMd: "통행본" },
        { label: "夫", interpretationMd: "이본" },
      ],
      anchors: [{
        targetKind: "source_text_version",
        targetVersionId: editor.source.versionId,
        codepointFrom: 0,
        codepointTo: 1,
        quote: editor.source.contentText.slice(0, 1),
      }],
    });
    expect(created).toMatchObject({ versionNo: 1, state: "open", blocking: true });
    expect(created.options).toHaveLength(2);
    expect(created.anchors[0]).toMatchObject({ codepointFrom: 0, codepointTo: 1 });
    expect(
      repo.previewContext({ documentNodeId: document.id }).auxiliary.find(
        (item) => item.id === created.id,
      ),
    ).toMatchObject({ defaultIncluded: true, reason: "related_uncertainty" });

    const revised = repo.createUncertaintyVersion({
      uncertaintyId: created.id,
      expectedVersionId: created.versionId,
      category: "interpretive",
      severity: "major",
      blocking: true,
      statementMd: "첫 구절의 해석을 확정해야 한다.",
      rationaleMd: "문법 해석 두 가지가 남아 있다.",
      confidenceLabel: "medium",
      options: [{ label: "주술 구조" }, { label: "병렬 구조" }],
      anchors: [{ targetKind: "document_node", targetVersionId: document.parentId!, quote: "상위 문서" }],
    });
    expect(revised).toMatchObject({ versionNo: 2, category: "interpretive" });
    expect(repo.getKnowledge().uncertainties.filter((item) => item.id === created.id)).toEqual([revised]);
    expect(repo.getHome().documents.find((item) => item.id === document.id)?.uncertaintyCount).toBe(
      initialUncertaintyCount + 1,
    );
    expect(
      repo.previewContext({ documentNodeId: document.id }).auxiliary.find(
        (item) => item.id === revised.id,
      ),
    ).toMatchObject({ defaultIncluded: true, reason: "related_uncertainty" });
    expectCode(
      () => repo.createUncertaintyVersion({
        uncertaintyId: created.id,
        expectedVersionId: created.versionId,
        category: "textual",
        severity: "minor",
        blocking: false,
        statementMd: "stale",
        options: [],
        anchors: [{ targetKind: "document_node", targetVersionId: document.id }],
      }),
      "cas_conflict",
    );
    expectCode(
      () => repo.confirmTranslation({
        documentNodeId: document.id,
        expectedLockVersion: translation.lockVersion,
      }),
      "open_blocking_uncertainty",
    );

    const resolved = repo.resolveUncertainty({ uncertaintyId: revised.id, expectedVersionId: revised.versionId });
    expect(resolved.state).toBe("resolved");
    const confirmed = repo.confirmTranslation({
      documentNodeId: document.id,
      expectedLockVersion: translation.lockVersion,
    });
    expect(confirmed.translation).toMatchObject({ versionId: translation.versionId, state: "confirmed" });
  });
});
