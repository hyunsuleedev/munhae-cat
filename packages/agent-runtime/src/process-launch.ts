import type { spawn as nodeSpawn } from "node:child_process";
import crossSpawn from "cross-spawn";

// cross-spawn resolves and escapes Windows npm .cmd shims. Prompts remain separate
// arguments/stdin; never concatenate user input into a shell command ourselves.
export const spawn = crossSpawn as typeof nodeSpawn;

export function execFileCaptured(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout = 5_000,
): Promise<{ error: NodeJS.ErrnoException | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = crossSpawn(command, [...args], {
      env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    let size = 0;
    let error: NodeJS.ErrnoException | null = null;
    const timer = setTimeout(() => {
      error = Object.assign(new Error("CLI probe timed out"), { code: "ETIMEDOUT" });
      child.kill();
    }, timeout);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          error = Object.assign(new Error("CLI probe output exceeded limit"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
          child.kill();
        } else chunks[stream].push(chunk);
      });
    }
    child.once("error", (failure) => { error = failure; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (!error && (code !== 0 || signal)) error = Object.assign(new Error(`CLI exited: ${code ?? signal}`), { code: String(code ?? signal) });
      resolve({ error, stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString() });
    });
  });
}
