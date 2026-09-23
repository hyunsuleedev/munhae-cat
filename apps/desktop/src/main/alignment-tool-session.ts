import { MunhaeError } from "@munhae/domain";
import type { ProjectRepo } from "@munhae/db-sqlite";
import type { AlignmentToolCommand, AlignmentToolReply } from "./agent-tool-bridge";

// A run can modify its saved alignment repeatedly, but must inspect the latest
// saved evidence before finishing. No separate staging data is involved.
export function createAlignmentToolSession(repo: Pick<ProjectRepo, "submitAlignment" | "checkAlignment" | "finishAlignment">, versionId: string) {
  let checkedRevision: string | null = null;
  let finished = false;
  return (command: AlignmentToolCommand, raw: string): AlignmentToolReply => {
    if (finished) return { ok: false, error: "already_finished" };
    try {
      const input = JSON.parse(raw);
      if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_payload" };
      if (command === "submit-alignment") {
        repo.submitAlignment(versionId, raw);
        checkedRevision = null;
        return { ok: true, saved: true, revision: repo.checkAlignment(versionId).revision, nextTool: "check-alignment" };
      }
      if (command === "check-alignment") {
        if (Object.keys(input).length) return { ok: false, error: "invalid_payload", message: "check-alignment 입력은 {}입니다." };
        const report = repo.checkAlignment(versionId);
        checkedRevision = report.revision;
        return { ok: true, ...report };
      }
      if (Object.keys(input).some(key => !["revision", "outcome", "unresolved"].includes(key))) return { ok: false, error: "invalid_payload" };
      if (!checkedRevision || input.revision !== checkedRevision) return { ok: false, error: "check_required", message: "마지막 입력 이후 check-alignment를 호출하고 반환된 revision을 사용하세요." };
      const result = repo.finishAlignment(versionId, input);
      finished = true;
      return { ok: true, ...result };
    } catch (error) {
      // Domain errors contain app-authored validation feedback. Never return
      // arbitrary runtime/SQL errors or credentials through the CLI.
      if (error instanceof MunhaeError) return { ok: false, error: error.code, message: error.message };
      if (error instanceof SyntaxError) return { ok: false, error: "invalid_json" };
      return { ok: false, error: "submission_rejected" };
    }
  };
}
