import { request } from "node:http";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const RESPONSE_LIMIT_BYTES = 64 * 1024;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

class PublicCliError extends Error {}

async function postTranslation(body: Buffer): Promise<void> {
  const endpoint = process.env.MUNHAE_TOOL_URL?.trim();
  const token = process.env.MUNHAE_TOOL_GRANT?.trim();
  const runId = process.env.MUNHAE_TOOL_RUN_ID?.trim();
  if (!endpoint || !token || !runId) throw new PublicCliError("문해 번역 제출 권한이 없습니다.");

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PublicCliError("문해 번역 제출 주소가 올바르지 않습니다.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1/tools/submit-translation") {
    throw new PublicCliError("문해 번역 제출 주소가 허용된 로컬 bridge가 아닙니다.");
  }

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
      response.on("end", () => resolve({
        statusCode: response.statusCode ?? 500,
        body: Buffer.concat(responseChunks).toString("utf8"),
      }));
    });
    call.once("timeout", () => call.destroy(new Error("request timed out")));
    call.once("error", reject);
    call.end(body);
  }).catch(() => {
    throw new PublicCliError("문해 앱에 번역을 제출하지 못했습니다.");
  });

  if (result.statusCode < 200 || result.statusCode >= 300) {
    let code = "submission_rejected";
    try {
      const parsed = JSON.parse(result.body) as { error?: unknown };
      if (typeof parsed.error === "string" && /^[a-z_]{1,64}$/u.test(parsed.error)) code = parsed.error;
    } catch {
      // Do not echo the bridge response or any submitted translation.
    }
    throw new PublicCliError(`문해 앱이 번역 제출을 거부했습니다: ${code}`);
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
      throw new PublicCliError("문해 번역 제출 내용이 너무 큽니다.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength);
}

async function submitTranslation(): Promise<void> {
  await postTranslation(await readSubmissionFromStdin());
}

async function main(): Promise<void> {
  if (
    process.argv[2] !== "tools"
    || !["submit-translation", "submit-alignment"].includes(process.argv[3] ?? "")
    || (process.env.MUNHAE_TOOL_COMMAND !== undefined && process.argv[3] !== process.env.MUNHAE_TOOL_COMMAND)
    || process.argv.length !== 4
  ) fail("사용법: munhae tools submit-translation");
  await submitTranslation();
}

void main().catch((error) => fail(
  error instanceof PublicCliError
    ? error.message
    : "문해 번역 제출 명령을 완료하지 못했습니다.",
));
