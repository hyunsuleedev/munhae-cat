import { describe, expect, it } from "vitest";
import { parseMoveDocumentInput } from "../src/main/ipc-validate";
describe("document organization IPC input", () => {
  const input = { documentNodeId: "source", parentId: "folder", beforeDocumentNodeId: null, expectedLockVersion: 1 };
  it("requires an explicit destination, insertion position and optimistic lock", () => {
    expect(parseMoveDocumentInput(input)).toEqual(input);
    expect(parseMoveDocumentInput({ ...input, beforeDocumentNodeId: "sibling" }).beforeDocumentNodeId).toBe("sibling");
    for (const patch of [{ parentId: null }, { parentId: "" }, { documentNodeId: "" }, { beforeDocumentNodeId: undefined }, { beforeDocumentNodeId: 5 }, { expectedLockVersion: -1 }, { expectedLockVersion: 1.5 }]) {
      expect(() => parseMoveDocumentInput({ ...input, ...patch })).toThrow();
    }
  });
});
