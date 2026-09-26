import { MunhaeError, sha256Hex } from "@munhae/domain";
import type { SqliteDb } from "./sqlite.ts";

/** A standard SKILL.md whose full text replaces the bundled translate-document method. */
export type TranslationSkill = {
  name: string;
  version: string | null;
  description: string;
  hash: string;
  content: string;
};

export const TRANSLATION_SKILL_MAX_CHARS = 60_000;
const RESERVED = new Set(["translate-document", "align-translation"]);
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const invalid = (message: string): never => {
  throw new MunhaeError("invalid_skill", message);
};

/** Reads the flat `key: value` frontmatter used by Agent Skills; nested YAML is ignored. */
function frontmatter(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const field = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!field) continue;
    let value = field[2]!.trim();
    if (/^[>|][+-]?$/.test(value)) {
      const folded = value.startsWith(">");
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(folded ? " " : "\n").trim();
    }
    fields.set(field[1]!, value.replace(/^(["'])([\s\S]*)\1$/, "$2"));
  }
  return fields;
}

export function parseTranslationSkill(raw: unknown): TranslationSkill {
  if (typeof raw !== "string") return invalid("SKILL.md 내용이 올바르지 않습니다");
  const content = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (content.length > TRANSLATION_SKILL_MAX_CHARS) invalid("SKILL.md가 60,000자를 넘습니다");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (!match) return invalid("SKILL.md 맨 앞에 ---로 감싼 name과 description이 필요합니다");
  const fields = frontmatter(match[1]!);
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  const version = fields.get("version") || null;
  if (!NAME.test(name)) invalid("name은 영문 소문자·숫자·하이픈으로 64자 이내여야 합니다");
  if (RESERVED.has(name)) invalid("기본 스킬과 같은 name은 사용할 수 없습니다");
  if (!description || description.length > 1024) invalid("description은 1자 이상 1,024자 이하여야 합니다");
  if (version && (version.length > 40 || /\s/.test(version))) invalid("version 형식이 올바르지 않습니다");
  if (!content.slice(match[0].length).trim()) invalid("SKILL.md 본문이 비어 있습니다");
  return { name, version, description, hash: sha256Hex(content), content };
}

function projectSettings(db: SqliteDb, projectId: string): Record<string, unknown> {
  const row = db.prepare("SELECT settings_json FROM core_project_settings WHERE project_id=?").get(projectId) as { settings_json: string | null } | undefined;
  if (!row) throw new MunhaeError("not_found", "프로젝트 설정을 찾지 못했습니다");
  try {
    const value: unknown = JSON.parse(row.settings_json ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Reported below. */ }
  throw new MunhaeError("skill_unavailable", "프로젝트 설정을 읽지 못했습니다");
}

/** The project stores the whole SKILL.md so collaborators and later audits see the exact method. */
export function readProjectTranslationSkill(db: SqliteDb, projectId: string): TranslationSkill | null {
  const stored = projectSettings(db, projectId).translationSkill;
  if (stored == null) return null;
  const content = typeof stored === "object" && !Array.isArray(stored) ? (stored as { content?: unknown }).content : undefined;
  if (typeof content !== "string") throw new MunhaeError("skill_unavailable", "프로젝트의 번역 플러그인을 읽지 못했습니다");
  return parseTranslationSkill(content);
}

export function writeProjectTranslationSkill(db: SqliteDb, projectId: string, skill: TranslationSkill | null): void {
  const settings = projectSettings(db, projectId);
  const current = settings.translationSkill as { content?: unknown } | undefined;
  if ((current?.content ?? null) === (skill?.content ?? null)) return;
  if (skill) settings.translationSkill = { content: skill.content };
  else delete settings.translationSkill;
  db.prepare("UPDATE core_project_settings SET settings_json=?, lock_version=lock_version+1 WHERE project_id=?")
    .run(JSON.stringify(settings), projectId);
}
