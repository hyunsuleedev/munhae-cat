import { describe, expect, it } from "vitest";
import { knowledgeTabFromHash } from "../src/renderer/scripts/knowledge-model";
import { parseSearchQueryInput } from "../src/main/ipc-validate";

describe("knowledge workspace routing", () => {
  it.each(["#persons", "#places", "", "#unknown"])("opens context for %s", (hash) => {
    expect(knowledgeTabFromHash(hash)).toBe("context");
  });

  it.each(["context", "glossary", "comments", "uncertainty"] as const)("preserves the %s bookmark", (tab) => {
    expect(knowledgeTabFromHash(`#${tab}`)).toBe(tab);
  });

  it("opens the background tab using the design prototype's name", () => {
    expect(knowledgeTabFromHash("#background")).toBe("context");
  });

  it("accepts glossary search filters and rejects removed entity filters", () => {
    const input = { query: "太守", entityFilter: { entityType: "glossary", entityId: "term-1" } };
    expect(parseSearchQueryInput(input).entityFilter).toEqual(input.entityFilter);
    for (const entityType of ["person", "place"]) {
      expect(() => parseSearchQueryInput({ ...input, entityFilter: { ...input.entityFilter, entityType } })).toThrow();
    }
  });
});
