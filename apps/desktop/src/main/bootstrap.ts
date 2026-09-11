// Keep the entry point free of native/project modules so a missing DLL or .node
// binary produces a visible error instead of disappearing before startup.
import { app, dialog } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

void import("./index").catch(async (error: unknown) => {
  await app.whenReady();
  const directory = app.getPath("logs");
  try {
    mkdirSync(directory, { recursive: true });
    // Module loader diagnostics only; no project or account data is initialized here.
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown bootstrap error";
    appendFileSync(join(directory, "startup-fatal.log"), `${new Date().toISOString()} ${process.platform} ${process.arch} Electron ${process.versions.electron}\n${detail}\n`, "utf8");
  } catch { /* A visible error must still be shown when logs cannot be written. */ }
  dialog.showErrorBox("문해를 시작하지 못했습니다", `필수 구성 요소를 불러오지 못했습니다. 설치 파일로 다시 설치하거나 진단 로그를 확인해 주세요.\n\n${directory}`);
  app.exit(1);
});
