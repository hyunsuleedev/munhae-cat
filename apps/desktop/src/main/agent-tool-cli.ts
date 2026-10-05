import { request } from "node:http";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024;
const ALIGNMENT_COMMANDS = ["submit-alignment", "check-alignment", "finish-alignment"];
const READING_COMMANDS = ["get-reading-context", "lookup-reading-dictionary", "submit-reading-analysis"];

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

class PublicCliError extends Error {}

async function postTool(body: Buffer): Promise<void> {
  const command = process.argv[3]!;
  const reading = READING_COMMANDS.includes(command);
  const endpoint = process.env.MUNHAE_TOOL_URL?.trim();
  const token = process.env.MUNHAE_TOOL_GRANT?.trim();
  const runId = process.env.MUNHAE_TOOL_RUN_ID?.trim();
  if (!endpoint || !token || !runId) throw new PublicCliError("문해 앱 도구 실행 권한이 없습니다.");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PublicCliError("문해 앱 도구 주소가 올바르지 않습니다.");
  }
  const allowedEndpoints = reading ? ["/v1/tools/get-reading-context"] : ["/v1/tools/submit-translation", "/v1/tools/submit-alignment"];
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || !allowedEndpoints.includes(url.pathname)) {
    throw new PublicCliError("문해 앱 도구 주소가 허용된 로컬 bridge가 아닙니다.");
  }

  // Older running app processes grant alignment submissions through the same
  // endpoint as translation. A freshly rebuilt wrapper must honor that exact
  // capability instead of redirecting a valid submission to a missing route.
  const legacyEndpoint = url.pathname === "/v1/tools/submit-translation";
  if (legacyEndpoint && ["check-alignment", "finish-alignment"].includes(command)) {
    throw new PublicCliError("실행 중인 문해 앱은 연결 검사 도구를 지원하지 않습니다. 앱을 다시 시작한 뒤 원문 연결을 재실행하세요.");
  }
  if (!legacyEndpoint) url.pathname = `/v1/tools/${command}`;
  const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const call = request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": body.byteLength,
        "x-munhae-run-id": runId,
      },
      timeout: 30_000,
    }, (response) => {
      const responseChunks: Buffer[] = [];
      let responseSize = 0;
      response.on("data", (chunk: Buffer) => {
        responseSize += chunk.byteLength;
        if (responseSize <= RESPONSE_LIMIT_BYTES) responseChunks.push(chunk);
      });
      response.once("error", reject);
      response.on("end", () => {
        if (responseSize > RESPONSE_LIMIT_BYTES) { reject(new PublicCliError("앱 도구 응답이 너무 큽니다.")); return; }
        resolve({ statusCode: response.statusCode ?? 500, body: Buffer.concat(responseChunks).toString("utf8") });
      });
    });
    call.once("timeout", () => call.destroy(new Error("request timed out")));
    call.once("error", reject);
    call.end(body);
  }).catch((error) => {
    if (error instanceof PublicCliError) throw error;
    throw new PublicCliError("문해 앱 도구를 실행하지 못했습니다.");
  });

  if (command !== "submit-translation") {
    let payload: unknown;
    try { payload = JSON.parse(result.body); } catch { throw new PublicCliError("앱 도구 응답 형식이 올바르지 않습니다."); }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (result.statusCode < 200 || result.statusCode >= 300) process.exitCode = 1;
    return;
  }
  if (result.statusCode < 200 || result.statusCode >= 300) {
    let code = "submission_rejected";
    let reason = "";
    try {
      const parsed = JSON.parse(result.body) as { error?: unknown; reason?: unknown };
      if (typeof parsed.error === "string" && /^[a-z_]{1,64}$/u.test(parsed.error)) code = parsed.error;
      // Only the app-authored format reason is shown; never the bridge body or submitted translation.
      if (code === "invalid_payload" && typeof parsed.reason === "string") reason = parsed.reason.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 200);
    } catch {
      // Do not echo the bridge response or any submitted translation.
    }
    throw new PublicCliError(`문해 앱이 번역 제출을 거부했습니다: ${code}${reason ? ` (${reason})` : ""}`);
  }
  process.stdout.write("문해가 완성 번역 하나를 수신했습니다.\n");
}

async function readSubmissionFromStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_INPUT_BYTES) {
      throw new PublicCliError("문해 앱 도구 입력 내용이 너무 큽니다.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength);
}

async function main(): Promise<void> {
  const command = process.argv[3] ?? "";
  const grantedCommand = process.env.MUNHAE_TOOL_COMMAND;
  const permitted = grantedCommand === "reading-analysis"
    ? READING_COMMANDS.includes(command)
    : grantedCommand === "submit-alignment"
      ? ALIGNMENT_COMMANDS.includes(command)
      : grantedCommand === undefined
        ? !READING_COMMANDS.includes(command)
        : command === grantedCommand && !READING_COMMANDS.includes(command);
  if (
    process.argv[2] !== "tools"
    || !["submit-translation", ...ALIGNMENT_COMMANDS, ...READING_COMMANDS].includes(command)
    || !permitted
    || process.argv.length !== 4
  ) fail("사용법: munhae tools <허용된 도구 명령>");
  await postTool(await readSubmissionFromStdin());
}

void main().catch((error) => fail(
  error instanceof PublicCliError
    ? error.message
    : "문해 앱 도구 명령을 완료하지 못했습니다.",
));
