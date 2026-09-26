import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { knowledgePage } from "../src/renderer/scripts/knowledge-model";
import { parseSearchQueryInput } from "../src/main/ipc-validate";

describe("knowledge workspace routing", () => {
  it.each([
    ["knowledge", "context"],
    ["glossary", "glossary"],
    ["comments", "comments"],
    ["uncertainty", "uncertainty"],
  ] as const)("%s.html is its own %s page without tabs", (file, page) => {
    const html = readFileSync(resolve("src/renderer", `${file}.html`), "utf8");
    expect(knowledgePage(html.match(/data-knowledge-page="([^"]+)"/)?.[1])).toBe(page);
    expect(html).not.toContain('role="tablist"');
  });

  it.each([undefined, "", "unknown"])("falls back to the context page for %s", (value) => {
    expect(knowledgePage(value)).toBe("context");
  });

  it("accepts glossary search filters and rejects removed entity filters", () => {
    const input = { query: "太守", entityFilter: { entityType: "glossary", entityId: "term-1" } };
    expect(parseSearchQueryInput(input).entityFilter).toEqual(input.entityFilter);
    for (const entityType of ["person", "place"]) {
      expect(() => parseSearchQueryInput({ ...input, entityFilter: { ...input.entityFilter, entityType } })).toThrow();
    }
  });
});
