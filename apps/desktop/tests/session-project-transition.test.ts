import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialog } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronPaths = vi.hoisted(() => ({ documents: "" }));
const fakeProjects = vi.hoisted(() => {
  let nextId = 0;

  function repo(title: string, packagePath: string) {
    const projectId = `project-${++nextId}`;
    return {
      projectId,
      title,
      packagePath,
      close: vi.fn(),
      setTranslationLanguage: vi.fn(),
      getHome: () => ({ project: { id: projectId } }),
    };
  }

  return {
    reset() {
      nextId = 0;
    },
    create(title: string, parentDir: string) {
      const handle = repo(title, `${parentDir}/${title}-${nextId + 1}.munhae`);
      return {
        handle,
        summary: {
          projectId: handle.projectId,
          title: handle.title,
          packagePath: handle.packagePath,
          storageMode: "local" as const,
          openedAt: "2026-09-04T00:00:00.000Z",
        },
      };
    },
    open(packagePath: string) {
      return repo("Opened", packagePath);
    },
    seed(parentDir: string) {
      return repo("Demo", `${parentDir}/demo-${nextId + 1}.munhae`);
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => electronPaths.documents,
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

vi.mock("../src/main/window", () => ({
  getMainWindow: () => null,
}));

vi.mock("../src/main/ai-runs", () => ({
  hasActiveAiRuns: () => false,
}));

vi.mock("../src/main/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@munhae/db-sqlite", () => ({
  createProject: ({ title, parentDir }: { title: string; parentDir: string }) =>
    fakeProjects.create(title, parentDir),
  openProject: (packagePath: string) => fakeProjects.open(packagePath),
  seedDemoProject: (parentDir: string) => fakeProjects.seed(parentDir),
}));

vi.mock("@munhae/project-format", () => ({
  readManifest: () => ({}),
  validateManifest: () => undefined,
}));

import {
  closeProject,
  createProjectInteractive,
  getCurrentSummary,
  openProjectInteractive,
  requireRepo,
  seedDemo,
} from "../src/main/session";

describe("main project transition preflight", () => {
  let root = "";
  let currentProjectId = "";

  beforeEach(async () => {
    closeProject(true);
    fakeProjects.reset();
    vi.mocked(dialog.showOpenDialog).mockReset();
    root = mkdtempSync(join(tmpdir(), "munhae-session-transition-"));
    electronPaths.documents = join(root, "documents");
    const current = await createProjectInteractive({ title: "Current", parentDir: root });
    currentProjectId = current.projectId;
  });

  afterEach(() => {
    closeProject(true);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("keeps the current repo when New is cancelled and replaces it when approved", async () => {
    const cancelled = await createProjectInteractive(
      { title: "Cancelled New", parentDir: root },
      () => false,
    );

    expect(cancelled).toBeNull();
    expect(getCurrentSummary()?.projectId).toBe(currentProjectId);
    expect(requireRepo().getHome().project.id).toBe(currentProjectId);

    const opened = await createProjectInteractive(
      { title: "Approved New", parentDir: root },
      () => true,
    );
    expect(opened?.projectId).not.toBe(currentProjectId);
    expect(getCurrentSummary()?.projectId).toBe(opened?.projectId);
  });

  it("keeps the current repo when Open is cancelled and opens the target when approved", async () => {
    const targetPath = join(root, "Open Target.munhae");
    mkdirSync(targetPath);

    const cancelled = await openProjectInteractive(targetPath, () => false);
    expect(cancelled).toBeNull();
    expect(getCurrentSummary()?.projectId).toBe(currentProjectId);
    expect(requireRepo().getHome().project.id).toBe(currentProjectId);

    const opened = await openProjectInteractive(targetPath, () => true);
    expect(opened?.projectId).not.toBe(currentProjectId);
    expect(opened?.packagePath).toBe(targetPath);
    expect(getCurrentSummary()?.projectId).toBe(opened?.projectId);
  });

  it("keeps the current repo when the native project chooser is cancelled", async () => {
    const current = requireRepo();
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });

    expect(await openProjectInteractive()).toBeNull();

    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
    expect(requireRepo()).toBe(current);
    expect(getCurrentSummary()?.projectId).toBe(currentProjectId);
    expect(current.close).not.toHaveBeenCalled();
  });

  it("opens the existing package directory returned by the native chooser", async () => {
    const current = requireRepo();
    const targetPath = join(root, "선택한 문헌.munhae");
    mkdirSync(targetPath);
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: [targetPath] });

    const opened = await openProjectInteractive();

    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
    expect(opened?.packagePath).toBe(targetPath);
    expect(opened?.projectId).not.toBe(currentProjectId);
    expect(getCurrentSummary()?.projectId).toBe(opened?.projectId);
    expect(requireRepo().packagePath).toBe(targetPath);
    expect(current.close).toHaveBeenCalledOnce();
  });

  it("restricts the native chooser to Munhae projects and backups without an all-files option", async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await openProjectInteractive();

    expect(dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      filters: [{ name: "문해 프로젝트 및 백업", extensions: ["munhae", "munhaepkg"] }],
    }));
    const [options] = vi.mocked(dialog.showOpenDialog).mock.calls[0]!;
    if (process.platform === "darwin") {
      // Packages are files in the native panel. Ordinary folders are for navigation only.
      expect(options).toHaveProperty("properties", ["openFile"]);
    }
    expect(getCurrentSummary()?.projectId).toBe(currentProjectId);
  });

  it("keeps the current repo when Seed Demo is cancelled and adopts it when approved", () => {
    expect(seedDemo(() => false)).toBeNull();
    expect(getCurrentSummary()?.projectId).toBe(currentProjectId);

    const opened = seedDemo(() => true);
    expect(opened?.projectId).not.toBe(currentProjectId);
    expect(getCurrentSummary()?.projectId).toBe(opened?.projectId);
  });

  it("keeps the current repo when Close is cancelled and clears it when approved", () => {
    closeProject(false, () => false);
    expect(getCurrentSummary()?.projectId).toBe(currentProjectId);
    expect(requireRepo().getHome().project.id).toBe(currentProjectId);

    closeProject(false, () => true);
    expect(getCurrentSummary()).toBeNull();
    expect(() => requireRepo()).toThrow(/열린 프로젝트가 없습니다/);
  });
});
