import { describe, expect, it } from "vitest";
import { redact } from "../src/main/log.ts";

describe("main-process log redaction", () => {
  it("removes complete authorization and cookie header values", () => {
    const result = redact([
      "Authorization: Bearer authorization-sentinel",
      "Proxy-Authorization: Basic proxy-sentinel",
      "Cookie: session=cookie-sentinel; other=value",
      "Set-Cookie: session=set-cookie-sentinel; HttpOnly",
    ].join("\n"));

    expect(result).not.toContain("authorization-sentinel");
    expect(result).not.toContain("proxy-sentinel");
    expect(result).not.toContain("cookie-sentinel");
    expect(result).not.toContain("set-cookie-sentinel");
    expect(result).toContain("Authorization: [REDACTED]");
    expect(result).toContain("Proxy-Authorization: [REDACTED]");
    expect(result).toContain("Cookie: [REDACTED]");
    expect(result).toContain("Set-Cookie: [REDACTED]");
  });

  it("redacts JSON credential assignments and credentialed URLs", () => {
    const result = redact(
      '{"apiKey":"json-secret","url":"https://name:url-secret@example.com/path"}',
    );

    expect(result).not.toContain("json-secret");
    expect(result).not.toContain("url-secret");
  });
});
