import { describe, expect, it } from "vitest";
import { parseDeleteDocumentInput, parseMoveDocumentInput } from "../src/main/ipc-validate";
describe("document organization IPC input", () => {
  const input = { documentNodeId: "source", parentId: "folder", beforeDocumentNodeId: null, expectedLockVersion: 1 };
  it("requires an explicit destination, insertion position and optimistic lock", () => {
    expect(parseMoveDocumentInput(input)).toEqual(input);
    expect(parseMoveDocumentInput({ ...input, beforeDocumentNodeId: "sibling" }).beforeDocumentNodeId).toBe("sibling");
    for (const patch of [{ parentId: null }, { parentId: "" }, { documentNodeId: "" }, { beforeDocumentNodeId: undefined }, { beforeDocumentNodeId: 5 }, { expectedLockVersion: -1 }, { expectedLockVersion: 1.5 }]) {
      expect(() => parseMoveDocumentInput({ ...input, ...patch })).toThrow();
    }
  });
  it("requires an optimistic lock and an explicit choice about terms and comments when deleting", () => {
    const deletion = { documentNodeId: "source", expectedLockVersion: 2, removeTermsAndComments: false };
    expect(parseDeleteDocumentInput(deletion)).toEqual(deletion);
    expect(parseDeleteDocumentInput({ ...deletion, removeTermsAndComments: true }).removeTermsAndComments).toBe(true);
    for (const patch of [{ documentNodeId: "" }, { expectedLockVersion: 0 }, { removeTermsAndComments: undefined }, { removeTermsAndComments: "yes" }]) {
      expect(() => parseDeleteDocumentInput({ ...deletion, ...patch })).toThrow();
    }
  });
});
