import type { McpChangeEvent, McpChangeView, MunhaeApi, ProjectSummary } from "../../shared/munhae-api";
import { t, ui } from "./i18n";
import type { ProjectRefresh } from "./project-change-ui";

type Notify = (message: string, title?: string, action?: { label: string; run(): void }) => void;

const RETRY_MS = 1000;
const MAX_ATTEMPTS = 120;

/**
 * Reloads open screens after an AI tool edits the project through MCP, and offers the undo.
 * Screens reuse the refresh they register for online changes; a blocked screen (unsaved edits,
 * a running task) retries until it can read again.
 */
export function initMcpChanges(api: MunhaeApi, project: ProjectSummary, notify: Notify): { register(refresh: ProjectRefresh): void } {
  const refreshes: ProjectRefresh[] = [];
  const run = async (refresh: ProjectRefresh, event: McpChangeEvent, attempt = 0): Promise<void> => {
    const retry = () => { if (attempt < MAX_ATTEMPTS) setTimeout(() => void run(refresh, event, attempt + 1), RETRY_MS); };
    if (refresh.blocked()) { retry(); return; }
    const version = refresh.version();
    try {
      const apply = await refresh.prepare({
        projectId: project.projectId, accountId: "", sessionId: "mcp", revision: 0,
        reason: "commit", documentIds: event.documentIds, scopes: event.scopes,
      });
      if (refresh.version() === version && !refresh.blocked()) apply();
      else retry();
    } catch {
      // The next change or page load reads the project again.
    }
  };
  const stop = api.mcp.onChanged((event) => {
    if (event.change.projectId !== project.projectId) return;
    for (const refresh of refreshes) void run(refresh, event);
    if (event.change.undoneAt) {
      notify(ui`되돌렸습니다: ${event.change.summary}`, event.change.label);
      return;
    }
    notify(event.change.summary, event.change.label, {
      label: t("되돌리기"),
      run: () => void api.mcp.undo(event.change.id).then((result) => {
        if (!result.ok) notify(result.error.message, t("되돌리기"));
      }),
    });
  });
  window.addEventListener("pagehide", () => stop(), { once: true });
  return { register: (refresh) => { refreshes.push(refresh); } };
}

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

/**
 * Lists this app run's MCP edits to one document in the history pane, each with its undo.
 * The list lives in the app's memory, so it ends when the app quits.
 */
export function mountMcpChangeList(api: MunhaeApi, container: HTMLElement, documentId: () => string | null, notify: Notify): { refresh(): void } {
  let changes: McpChangeView[] = [];
  const render = () => {
    const id = documentId();
    const rows = changes.filter(change => change.documentId === id);
    container.hidden = !rows.length;
    if (!rows.length) { container.replaceChildren(); return; }
    const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    container.innerHTML = ui`<p class="muted" style="font-size:11.5px;margin-bottom:4px">AI 도구가 이번 실행 중에 바꾼 내용입니다. 앱을 끄면 여기서 되돌릴 수 없습니다.</p>`
      + rows.map(change => `<div class="hist-item mcp-change">
        <span class="v">AI</span>
        <span><span>${escapeHtml(change.summary)}</span><span class="when">${escapeHtml(time(change.createdAt))} · ${escapeHtml(change.label)}${change.undoneAt ? ` · ${escapeHtml(t("되돌림"))}` : ""}</span></span>
        ${change.undoneAt ? "" : `<button class="btn btn-sm" type="button" data-mcp-undo="${escapeHtml(change.id)}">${escapeHtml(t("되돌리기"))}</button>`}
      </div>`).join("");
  };
  const refresh = () => void api.mcp.list().then((result) => { if (result.ok) { changes = result.data; render(); } }).catch(() => undefined);
  container.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-mcp-undo]");
    if (!button?.dataset.mcpUndo) return;
    button.disabled = true;
    void api.mcp.undo(button.dataset.mcpUndo).then((result) => {
      if (!result.ok) { button.disabled = false; notify(result.error.message, t("되돌리기")); }
    });
  });
  const stop = api.mcp.onChanged(() => refresh());
  window.addEventListener("pagehide", () => stop(), { once: true });
  refresh();
  return { refresh: render };
}
