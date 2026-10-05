import { app, BrowserWindow } from "electron";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FOOTER = '<div style="width:100%;text-align:center;font-size:8px;color:#6f6a60"><span class="pageNumber"></span></div>';

/**
 * Print a self-contained page (its CSP blocks every fetch) to A4 PDF. The page
 * goes through a temporary file because data: URLs are capped at 2 MB, and the
 * hidden window has no script, preload or persistent session.
 */
export async function printHtmlToPdf(html: string): Promise<Buffer> {
  const dir = mkdtempSync(join(app.getPath("temp"), "munhae-print-"));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, spellcheck: false, partition: "munhae-print" },
  });
  try {
    const page = join(dir, "export.html");
    writeFileSync(page, html, "utf8");
    await win.loadFile(page);
    return await win.webContents.printToPDF({
      pageSize: "A4",
      preferCSSPageSize: true,
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: FOOTER,
      generateDocumentOutline: true,
    });
  } finally {
    win.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}
