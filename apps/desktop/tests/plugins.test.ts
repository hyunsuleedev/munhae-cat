import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/munhae-api";

type Row = { name: string; content: string; published: boolean };
const mocks = vi.hoisted(() => ({
  root: "", summary: null as object | null, picked: null as string | null,
  getTranslationSkill: vi.fn(), setTranslationSkill: vi.fn(),
  rows: [] as Row[], catalogError: null as object | null,
}));
/** Mirrors the PostgREST builder calls used by the catalog: eq filters, order, limit or maybeSingle. */
function query(filters: Array<[keyof Row, unknown]> = []): Record<string, unknown> {
  const match = () => mocks.rows.filter((row) => filters.every(([key, value]) => row[key] === value)).map(({ name, content }) => ({ name, content }));
  const result = <T>(data: T) => Promise.resolve(mocks.catalogError ? { data: null, error: mocks.catalogError } : { data, error: null });
  return {
    select: () => query(filters),
    eq: (key: keyof Row, value: unknown) => query([...filters, [key, value]]),
    order: () => query(filters),
    limit: () => result(match()),
    maybeSingle: () => result(match()[0] ?? null),
  };
}
vi.mock("../src/main/auth", () => ({
  withAuthenticatedClient: (action: (client: unknown, userId: string) => Promise<unknown>) =>
    action({ from: (table: string) => { expect(table).toBe("plugin_catalog"); return query(); } }, "reader"),
}));
vi.mock("../src/main/session", () => ({
  getCurrentSummary: () => mocks.summary,
  pickSkillFile: async () => mocks.picked,
  pluginLibraryDir: () => mocks.root,
  requireRepo: () => ({ getTranslationSkill: mocks.getTranslationSkill, setTranslationSkill: mocks.setTranslationSkill }),
}));

import { installPlugin, listInstalledPlugins, removePlugin } from "../src/main/plugin-library";
import { dispatchPlugin } from "../src/main/plugins";

const skill = (name: string, body = "관직명은 원문 표기를 유지한다.") =>
  `---\nname: ${name}\nversion: 1.0.0\ndescription: ${name} 번역 지침\n---\n${body}\n`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.root = mkdtempSync(join(tmpdir(), "munhae-plugins-"));
  mocks.summary = null;
  mocks.picked = null;
  mocks.rows = [];
  mocks.catalogError = null;
});
afterEach(() => rmSync(mocks.root, { recursive: true, force: true }));

describe("plugin library", () => {
  it("installs SKILL.md folders by name, replaces updates and skips unusable folders", () => {
    installPlugin(mocks.root, skill("sillok-style"));
    installPlugin(mocks.root, skill("annals", "첫 판"));
    const updated = installPlugin(mocks.root, skill("annals", "둘째 판"));
    mkdirSync(join(mocks.root, "broken"));
    writeFileSync(join(mocks.root, "broken", "SKILL.md"), "frontmatter 없음");
    mkdirSync(join(mocks.root, "renamed"));
    writeFileSync(join(mocks.root, "renamed", "SKILL.md"), skill("other-name"));

    const installed = listInstalledPlugins(mocks.root);
    expect(installed.map((plugin) => plugin.name)).toEqual(["annals", "sillok-style"]);
    expect(installed[0]).toMatchObject({ version: "1.0.0", hash: updated.hash });
    expect(readFileSync(join(mocks.root, "annals", "SKILL.md"), "utf8")).toContain("둘째 판");

    removePlugin(mocks.root, "annals");
    expect(listInstalledPlugins(mocks.root).map((plugin) => plugin.name)).toEqual(["sillok-style"]);
    expect(() => removePlugin(mocks.root, "../outside")).toThrow();
    expect(() => installPlugin(mocks.root, skill("translate-document"))).toThrow(/기본 스킬/);
  });
});

describe("plugin requests", () => {
  it("lists without a project and applies only installed plugin text to the open project", async () => {
    installPlugin(mocks.root, skill("sillok-style"));
    expect(await dispatchPlugin(IPC_CHANNELS.pluginsList, undefined)).toMatchObject({ projectOpen: false, applied: null });
    expect(mocks.getTranslationSkill).not.toHaveBeenCalled();

    mocks.summary = { projectId: "project-1" };
    mocks.setTranslationSkill.mockImplementation((content: string | null) => content && { name: "sillok-style", content });
    await dispatchPlugin(IPC_CHANNELS.pluginsApply, "sillok-style");
    expect(mocks.setTranslationSkill).toHaveBeenLastCalledWith(skill("sillok-style"));
    await dispatchPlugin(IPC_CHANNELS.pluginsApply, null);
    expect(mocks.setTranslationSkill).toHaveBeenLastCalledWith(null);
    await expect(dispatchPlugin(IPC_CHANNELS.pluginsApply, "missing")).rejects.toThrow(/찾지 못했습니다/);
    await expect(dispatchPlugin(IPC_CHANNELS.pluginsApply, "../x")).rejects.toThrow();
  });

  it("installs the picked SKILL.md and treats a cancelled picker as no change", async () => {
    expect(await dispatchPlugin(IPC_CHANNELS.pluginsInstall, undefined)).toBeNull();
    mocks.picked = skill("annals");
    expect(await dispatchPlugin(IPC_CHANNELS.pluginsInstall, undefined)).toMatchObject({ name: "annals" });
    expect(listInstalledPlugins(mocks.root).map((plugin) => plugin.name)).toEqual(["annals"]);
  });
});

describe("recommended plugin catalog", () => {
  it("lists only published rows that are valid SKILL.md files for their own name", async () => {
    mocks.rows = [
      { name: "sillok-style", content: skill("sillok-style"), published: true },
      { name: "draft", content: skill("draft"), published: false },
      { name: "broken", content: "frontmatter 없음", published: true },
      { name: "renamed", content: skill("other-name"), published: true },
    ];
    expect(await dispatchPlugin(IPC_CHANNELS.pluginsCatalog, undefined)).toEqual([expect.objectContaining({ name: "sillok-style", version: "1.0.0" })]);
    mocks.catalogError = { message: "network" };
    await expect(dispatchPlugin(IPC_CHANNELS.pluginsCatalog, undefined)).rejects.toThrow(/추천 플러그인을 불러오지 못했습니다/);
  });

  it("installs the server copy by name into the local library", async () => {
    mocks.rows = [
      { name: "annals", content: skill("annals", "서버 본문"), published: true },
      { name: "draft", content: skill("draft"), published: false },
    ];
    expect(await dispatchPlugin(IPC_CHANNELS.pluginsInstallCatalog, "annals")).toMatchObject({ name: "annals" });
    expect(readFileSync(join(mocks.root, "annals", "SKILL.md"), "utf8")).toContain("서버 본문");
    await expect(dispatchPlugin(IPC_CHANNELS.pluginsInstallCatalog, "draft")).rejects.toThrow(/찾지 못했습니다/);
    await expect(dispatchPlugin(IPC_CHANNELS.pluginsInstallCatalog, { content: "x" })).rejects.toThrow();
  });
});
