import { dialog, shell, type OpenDialogOptions } from "electron";
import type { EditorView, ReferenceAssetContent } from "@munhae/db-sqlite";
import { AppError } from "./errors";
import { requireRepo } from "./session";
import { getMainWindow } from "./window";

export async function attachReferenceInteractive(documentNodeId: string): Promise<EditorView | null> {
  const win = getMainWindow() ?? undefined;
  const options: OpenDialogOptions = {
    title: "참고 이미지·PDF 첨부",
    buttonLabel: "첨부",
    properties: ["openFile"],
    filters: [
      { name: "이미지와 PDF", extensions: ["avif", "bmp", "gif", "jpeg", "jpg", "pdf", "png", "tif", "tiff", "webp"] },
    ],
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  const sourcePath = result.filePaths[0];
  if (result.canceled || !sourcePath) return null;
  return requireRepo().attachReferenceAsset(documentNodeId, sourcePath);
}

export function readReference(documentNodeId: string, assetId: string): ReferenceAssetContent {
  return requireRepo().readReferenceAsset(documentNodeId, assetId);
}

export async function openReference(documentNodeId: string, assetId: string): Promise<void> {
  const path = requireRepo().referenceAssetPath(documentNodeId, assetId);
  const error = await shell.openPath(path);
  if (error) throw new AppError("open_path_failed", "참고 자료를 열 수 없습니다.");
}
