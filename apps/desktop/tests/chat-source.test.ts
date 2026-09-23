import { expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn(async () => {}) } }));
import { shell } from "electron";
import { openChatSource, isAllowedExternalUrl } from "../src/main/security";
it("opens a research citation beyond the dictionary allowlist via the external browser", async () => {
  expect(isAllowedExternalUrl("https://example.com/source")).toBe(false);
  await openChatSource("https://example.com/source");
  expect(shell.openExternal).toHaveBeenCalledWith("https://example.com/source");
});
it.each(["javascript:alert(1)", "file:///etc/passwd", "data:text/html,test", "https://user:password@example.com"])('rejects non-web or credential-bearing citation %s', async value => {
  await expect(openChatSource(value)).rejects.toThrow();
});
