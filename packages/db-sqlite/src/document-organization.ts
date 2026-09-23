import { MunhaeError, nowIso } from "@munhae/domain";
import { allRows } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { MoveDocumentInput } from "./views.ts";

type Node = { id: string; parent_node_id: string | null; node_role: string; is_master: number; ordinal: number; lock_version: number; archived_at: string | null };

/** Move a whole branch or reorder siblings atomically, preserving document content. */
export function moveDocument(db: SqliteDb, projectId: string, input: MoveDocumentInput): void {
  db.transaction(() => {
    const nodes = allRows<Node>(db, `SELECT id, parent_node_id, node_role, is_master, ordinal, lock_version, archived_at FROM document_nodes WHERE project_id = ? ORDER BY ordinal, id`, projectId);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const node = byId.get(input.documentNodeId), parent = byId.get(input.parentId);
    if (!node || node.archived_at) throw new MunhaeError("not_found", "이동할 문서를 찾을 수 없습니다");
    if (node.is_master) throw new MunhaeError("immutable_master", "프로젝트 마스터 폴더는 이동할 수 없습니다");
    if (node.lock_version !== input.expectedLockVersion) throw new MunhaeError("cas_conflict", "문서가 다른 창에서 변경되었습니다. 다시 열어 주세요.");
    if (!parent || parent.archived_at || parent.node_role !== "container") throw new MunhaeError("invalid_parent", "이동 위치는 현재 프로젝트의 폴더여야 합니다");
    const seen = new Set<string>();
    let ancestor: Node | undefined = parent;
    while (ancestor) {
      if (ancestor.id === node.id || seen.has(ancestor.id)) throw new MunhaeError("invalid_parent", "자기 자신이나 하위 폴더로 이동할 수 없습니다");
      seen.add(ancestor.id);
      if (!ancestor.parent_node_id) break;
      ancestor = byId.get(ancestor.parent_node_id);
      if (!ancestor || ancestor.archived_at) throw new MunhaeError("invalid_parent", "이동 위치의 상위 폴더를 찾을 수 없습니다");
    }
    const destination = nodes.filter(item => item.parent_node_id === parent.id && item.id !== node.id);
    let index = destination.length;
    if (input.beforeDocumentNodeId !== null) {
      index = destination.findIndex(item => item.id === input.beforeDocumentNodeId && !item.archived_at);
      if (index < 0) throw new MunhaeError("invalid_position", "문서 순서가 변경되었습니다. 위치를 다시 선택해 주세요.");
    }
    destination.splice(index, 0, node);
    const placements = destination.map((item, ordinal) => ({ item, parentId: parent.id, ordinal }));
    if (node.parent_node_id !== parent.id) {
      nodes.filter(item => item.parent_node_id === node.parent_node_id && item.id !== node.id)
        .forEach((item, ordinal) => placements.push({ item, parentId: node.parent_node_id!, ordinal }));
    }
    if (placements.every(({ item, parentId, ordinal }) => item.parent_node_id === parentId && item.ordinal === ordinal)) return;
    // Unique sibling ordinals also cover archived rows. Park every affected row
    // below the project's minimum before assigning the final order.
    const floor = Math.min(0, ...nodes.map(item => item.ordinal)) - placements.length - 1;
    const park = db.prepare("UPDATE document_nodes SET ordinal = ? WHERE id = ? AND project_id = ?");
    placements.forEach(({ item }, i) => park.run(floor + i, item.id, projectId));
    const update = db.prepare(`UPDATE document_nodes SET parent_node_id = ?, ordinal = ?, lock_version = lock_version + ?, updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END WHERE id = ? AND project_id = ?`);
    const now = nowIso();
    placements.forEach(({ item, parentId, ordinal }) => {
      const changed = Number(item.parent_node_id !== parentId || item.ordinal !== ordinal);
      update.run(parentId, ordinal, changed, changed, now, item.id, projectId);
    });
  })();
}
