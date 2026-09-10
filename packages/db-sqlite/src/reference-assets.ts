import { closeSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { extname } from "node:path";
import { createId, MunhaeError, nowIso } from "@munhae/domain";
import {
  importOriginalAsset,
  readVerifiedProjectAsset,
  resolvePackagePath,
  verifyProjectAsset,
} from "@munhae/project-format";
import type { ReferenceAssetContent, ReferenceAssetState, ReferenceAssetView } from "./views.ts";
import type { SqliteDb } from "./sqlite.ts";

export const REFERENCE_ASSET_MAX_BYTES = 200 * 1024 * 1024;
const REFERENCE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

type AssetRow = {
  id: string;
  asset_kind: "image" | "pdf";
  original_filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  page_count: number | null;
  role: "reference";
  page_from: number | null;
  page_to: number | null;
  locator_text: string | null;
  ordinal: number;
  relative_path: string;
};

function readHeader(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(32);
    const length = readSync(fd, bytes, 0, bytes.byteLength, 0);
    return bytes.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return Buffer.from(bytes.subarray(from, to)).toString("ascii");
}

function matchesSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "application/pdf") return ascii(bytes, 0, 5) === "%PDF-";
  if (mimeType === "image/png") return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") return ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6));
  if (mimeType === "image/bmp") return ascii(bytes, 0, 2) === "BM";
  if (mimeType === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
  if (mimeType === "image/tiff") {
    return ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*";
  }
  if (mimeType === "image/avif") {
    return ascii(bytes, 4, 8) === "ftyp" && /avif|avis/.test(ascii(bytes, 8, 32));
  }
  return false;
}

function validateExternalAsset(sourcePath: string): { mimeType: string; byteSize: number } {
  const st = statSync(sourcePath);
  if (!st.isFile()) throw new MunhaeError("invalid_asset", "참고 자료는 일반 파일이어야 합니다");
  if (st.size <= 0) throw new MunhaeError("invalid_asset", "빈 파일은 첨부할 수 없습니다");
  if (st.size > REFERENCE_ASSET_MAX_BYTES) {
    throw new MunhaeError("asset_too_large", "참고 자료는 200MB 이하여야 합니다");
  }
  const mimeType = MIME_BY_EXTENSION[extname(sourcePath).toLowerCase()];
  if (!mimeType) throw new MunhaeError("unsupported_asset", "이미지 또는 PDF만 첨부할 수 있습니다");
  if (!matchesSignature(mimeType, readHeader(sourcePath))) {
    throw new MunhaeError("invalid_asset", "파일 내용이 확장자와 일치하지 않습니다");
  }
  return { mimeType, byteSize: st.size };
}

/**
 * Revalidates the package-contained bytes rather than trusting the earlier
 * external-file check. This closes the selection-to-copy race and removes an
 * unsafe copy before any project row can reference it.
 */
export function validatePackagedReferenceAsset(
  packagePath: string,
  imported: { relativePath: string; sha256: string; mimeType: string; byteSize: number },
  expected: { mimeType: string; byteSize: number },
): void {
  const importedPath = resolvePackagePath(packagePath, imported.relativePath);
  try {
    const packagedBytes = readVerifiedProjectAsset(packagePath, imported);
    if (
      imported.mimeType !== expected.mimeType
      || imported.byteSize !== expected.byteSize
      || !matchesSignature(expected.mimeType, packagedBytes.subarray(0, 32))
    ) {
      throw new MunhaeError("invalid_asset", "복사된 참고 자료가 선택한 원본과 일치하지 않습니다");
    }
  } catch (error) {
    rmSync(importedPath, { force: true });
    if (error instanceof MunhaeError && error.code === "invalid_asset") throw error;
    throw new MunhaeError(
      "invalid_asset",
      error instanceof Error ? `복사된 참고 자료를 검증할 수 없습니다: ${error.message}` : "복사된 참고 자료를 검증할 수 없습니다",
    );
  }
}

function removeImportedAssetIfUnreferenced(
  db: SqliteDb,
  packagePath: string,
  relativePath: string,
): void {
  try {
    const referenced = db.prepare(
      "SELECT 1 FROM src_asset_locations WHERE relative_path = ? LIMIT 1",
    ).get(relativePath);
    if (!referenced) rmSync(resolvePackagePath(packagePath, relativePath), { force: true });
  } catch {
    // Never turn a primary database failure into a broad or unsafe file delete.
  }
}

function requireDocument(db: SqliteDb, projectId: string, documentNodeId: string): void {
  const row = db.prepare(
    `SELECT 1 FROM document_nodes
     WHERE id = ? AND project_id = ? AND archived_at IS NULL AND node_role = 'source_unit'`,
  ).get(documentNodeId, projectId);
  if (!row) throw new MunhaeError("not_found", "참고 자료를 연결할 원문 문서가 없습니다");
}

function loadRows(db: SqliteDb, projectId: string, documentNodeId: string): AssetRow[] {
  return db.prepare(
    `SELECT a.id,
            CASE WHEN a.mime_type = 'application/pdf' THEN 'pdf' ELSE 'image' END AS asset_kind,
            COALESCE(a.original_filename, '참고 자료') AS original_filename,
            COALESCE(a.mime_type, 'application/octet-stream') AS mime_type,
            COALESCE(a.byte_size, -1) AS byte_size,
            COALESCE(a.sha256, '') AS sha256,
            a.page_count, na.role, na.page_from, na.page_to, na.locator_text, na.ordinal,
            l.relative_path
     FROM src_node_assets na
     JOIN src_assets a ON a.id = na.asset_id AND a.project_id = na.project_id
     JOIN src_asset_locations l ON l.id = (
       SELECT l2.id FROM src_asset_locations l2
       WHERE l2.asset_id = a.id AND l2.project_id = a.project_id
       ORDER BY CASE WHEN l2.state = 'present' THEN 0 ELSE 1 END,
                l2.verified_at DESC,
                l2.id DESC
       LIMIT 1
     )
     WHERE na.project_id = ? AND na.document_node_id = ? AND na.role = 'reference'
       AND (a.mime_type = 'application/pdf' OR a.mime_type LIKE 'image/%')
     ORDER BY na.ordinal, a.id`,
  ).all(projectId, documentNodeId) as AssetRow[];
}

function verificationState(
  result: ReturnType<typeof verifyProjectAsset>,
): ReferenceAssetState {
  return result.valid || result.reason === "ok" ? "present" : result.reason;
}

function verifyRow(
  db: SqliteDb,
  packagePath: string,
  projectId: string,
  row: AssetRow,
): ReferenceAssetView {
  const verifiedAt = nowIso();
  const result = verifyProjectAsset(packagePath, {
    relativePath: row.relative_path,
    sha256: row.sha256,
    byteSize: row.byte_size,
  });
  const state = verificationState(result);
  db.prepare(
    `UPDATE src_asset_locations SET state = ?, verified_at = ?
     WHERE project_id = ? AND asset_id = ? AND relative_path = ?`,
  ).run(state, verifiedAt, projectId, row.id, row.relative_path);
  return {
    id: row.id,
    assetKind: row.asset_kind,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    pageCount: row.page_count,
    role: row.role,
    pageFrom: row.page_from,
    pageTo: row.page_to,
    locatorText: row.locator_text,
    ordinal: row.ordinal,
    state,
    verifiedAt,
  };
}

export function listReferenceAssets(opts: {
  db: SqliteDb;
  packagePath: string;
  projectId: string;
  documentNodeId: string;
}): ReferenceAssetView[] {
  requireDocument(opts.db, opts.projectId, opts.documentNodeId);
  return loadRows(opts.db, opts.projectId, opts.documentNodeId).map((row) =>
    verifyRow(opts.db, opts.packagePath, opts.projectId, row),
  );
}

export function attachReferenceAsset(opts: {
  db: SqliteDb;
  packagePath: string;
  projectId: string;
  documentNodeId: string;
  sourcePath: string;
  actorId: string;
}): ReferenceAssetView[] {
  const expected = validateExternalAsset(opts.sourcePath);
  requireDocument(opts.db, opts.projectId, opts.documentNodeId);
  const imported = importOriginalAsset({ packagePath: opts.packagePath, sourcePath: opts.sourcePath });
  validatePackagedReferenceAsset(opts.packagePath, imported, expected);

  try {
    opts.db.transaction(() => {
      const existing = opts.db.prepare(
        `SELECT id FROM src_assets
         WHERE project_id = ? AND sha256 = ? AND byte_size = ? AND mime_type = ?
         LIMIT 1`,
      ).get(opts.projectId, imported.sha256, imported.byteSize, imported.mimeType) as { id: string } | undefined;
      const assetId = existing?.id ?? createId();
      if (!existing) {
        opts.db.prepare(
          `INSERT INTO src_assets
            (id, project_id, asset_kind, original_filename, mime_type, byte_size, sha256,
             width, height, page_count, source_uri, acquired_at, created_by_actor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
        ).run(
          assetId,
          opts.projectId,
          imported.mimeType === "application/pdf" ? "pdf" : "image",
          imported.originalFilename,
          imported.mimeType,
          imported.byteSize,
          imported.sha256,
          nowIso(),
          opts.actorId,
        );
      }
      const location = opts.db.prepare(
        `SELECT id FROM src_asset_locations WHERE project_id = ? AND asset_id = ? LIMIT 1`,
      ).get(opts.projectId, assetId) as { id: string } | undefined;
      if (!location) {
        opts.db.prepare(
          `INSERT INTO src_asset_locations
            (id, project_id, asset_id, relative_path, state, verified_at)
           VALUES (?, ?, ?, ?, 'present', ?)`,
        ).run(createId(), opts.projectId, assetId, imported.relativePath, nowIso());
      } else {
        // The same content can be re-attached under a different filename. Point the
        // canonical DB location at the newly verified package-relative copy.
        opts.db.prepare(
          `UPDATE src_asset_locations
           SET relative_path = ?, state = 'present', verified_at = ?
           WHERE id = ? AND project_id = ? AND asset_id = ?`,
        ).run(imported.relativePath, nowIso(), location.id, opts.projectId, assetId);
      }
      const linked = opts.db.prepare(
        `SELECT 1 FROM src_node_assets
         WHERE project_id = ? AND document_node_id = ? AND asset_id = ? AND role = 'reference'
         LIMIT 1`,
      ).get(opts.projectId, opts.documentNodeId, assetId);
      if (!linked) {
        const next = opts.db.prepare(
          `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
           FROM src_node_assets WHERE project_id = ? AND document_node_id = ?`,
        ).get(opts.projectId, opts.documentNodeId) as { ordinal: number };
        opts.db.prepare(
          `INSERT INTO src_node_assets
            (project_id, document_node_id, asset_id, role, page_from, page_to, locator_text, ordinal)
           VALUES (?, ?, ?, 'reference', NULL, NULL, NULL, ?)`,
        ).run(opts.projectId, opts.documentNodeId, assetId, next.ordinal);
      }
    })();
  } catch (error) {
    removeImportedAssetIfUnreferenced(opts.db, opts.packagePath, imported.relativePath);
    throw error;
  }

  return listReferenceAssets(opts);
}

function requireReferenceRow(opts: {
  db: SqliteDb;
  packagePath: string;
  projectId: string;
  documentNodeId: string;
  assetId: string;
}): { row: AssetRow; view: ReferenceAssetView; absolutePath: string } {
  requireDocument(opts.db, opts.projectId, opts.documentNodeId);
  const row = loadRows(opts.db, opts.projectId, opts.documentNodeId).find((item) => item.id === opts.assetId);
  if (!row) throw new MunhaeError("not_found", "이 문서에 연결된 참고 자료가 아닙니다");
  const view = verifyRow(opts.db, opts.packagePath, opts.projectId, row);
  if (view.state !== "present") {
    throw new MunhaeError("asset_unavailable", `참고 자료를 열 수 없습니다: ${view.state}`);
  }
  return { row, view, absolutePath: resolvePackagePath(opts.packagePath, row.relative_path) };
}

export function readReferenceAsset(opts: {
  db: SqliteDb;
  packagePath: string;
  projectId: string;
  documentNodeId: string;
  assetId: string;
}): ReferenceAssetContent {
  const { row, view } = requireReferenceRow(opts);
  if (view.byteSize > REFERENCE_PREVIEW_MAX_BYTES) {
    throw new MunhaeError(
      "asset_preview_too_large",
      "64MB가 넘는 참고 자료는 시스템 뷰어에서 여세요",
    );
  }
  return {
    assetId: view.id,
    mimeType: view.mimeType,
    base64: readVerifiedProjectAsset(opts.packagePath, {
      relativePath: row.relative_path,
      sha256: view.sha256,
      byteSize: view.byteSize,
    }).toString("base64"),
  };
}

export function referenceAssetPath(opts: {
  db: SqliteDb;
  packagePath: string;
  projectId: string;
  documentNodeId: string;
  assetId: string;
}): string {
  return requireReferenceRow(opts).absolutePath;
}
