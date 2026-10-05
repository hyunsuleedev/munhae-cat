// Shared by the in-app MCP server and the stdio relay, so the relay can list tools
// and answer clearly while Munhae is closed. Keep this module dependency-free.

export const MCP_PORT = 27183;
export const MCP_PATH = "/mcp";
export const MCP_SERVER_NAME = "munhae";
export const MCP_SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const MCP_DEFAULT_PROTOCOL = "2025-06-18";

export const MCP_INSTRUCTIONS = [
  "문해(Munhae Studio)는 고전 한문 번역 작업 앱입니다. 이 도구들은 사용자가 지금 문해에서 열어 둔 프로젝트를 다룹니다.",
  "먼저 get_open_project로 프로젝트와 문서 목록을 확인하세요. 다른 도구에는 거기서 받은 projectId를 넘깁니다.",
  "문해 데이터는 이 도구로만 읽고 씁니다. 문해의 프로젝트 파일, 데이터베이스, 소스코드, 프로세스, 포트에 다른 방법으로 접근하지 마세요.",
  "원문 내용을 조사하려고 인터넷을 검색하는 것은 괜찮습니다.",
  "도구가 멈추라고 답하면 다른 길을 찾지 말고 그 내용을 사용자에게 알리세요.",
].join("\n");

export const MCP_APP_NOT_RUNNING = "[app_not_running] 문해가 실행 중이 아닙니다. 사용자에게 문해를 열어 달라고 요청한 뒤 다시 시도하세요. 다른 방법으로 문해 데이터에 접근하지 마세요.";

export type McpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: readonly string[]; additionalProperties: false };
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: false };
};

const projectId = { type: "string", description: "get_open_project에서 받은 프로젝트 ID" };
const documentId = { type: "string", description: "get_open_project에서 받은 문서 ID" };
const read = { readOnlyHint: true, openWorldHint: false } as const;
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Same list as the database's TERM_KINDS; kept here so the relay bundle stays dependency-free. */
export const MCP_TERM_KINDS = ["person", "place", "period", "event", "object", "work", "concept", "allusion", "grammar", "idu"] as const;
/** Same list as the database's TERM_CONFIDENCE. */
export const MCP_TERM_CONFIDENCE = ["certain", "probable", "unknown"] as const;
const termJudgment = {
  confidence: { type: "string", enum: MCP_TERM_CONFIDENCE, description: "이 문서에서의 판단을 얼마나 확신하는지: certain 확정, probable 유력, unknown 미상. 생략하면 certain" },
  alternatives: { type: "array", maxItems: 3, items: { type: "string", maxLength: 300 }, description: "실제로 경쟁하는 다른 해석이나 식별" },
} as const;
const termKind = { type: "string", enum: MCP_TERM_KINDS, description: "person 인물, place 장소, period 시기, event 사건, object 사물, work 작품·문헌, concept 개념(제도·관직 포함), allusion 전고, grammar 문법, idu 이두" };
const documentInput = {
  type: "object",
  properties: { projectId, documentId },
  required: ["projectId", "documentId"],
  additionalProperties: false,
} as const;

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "get_open_project",
    title: "열린 프로젝트",
    description: "문해에서 지금 열려 있는 프로젝트의 ID·제목·번역 언어와 문서 목록(단계별 상태 포함)을 돌려줍니다. 다른 도구보다 먼저 호출하세요.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: read,
  },
  {
    name: "get_document",
    title: "문서 읽기",
    description: "문서의 정보, 저장된 원문, 표점본, 번역 전문과 문장 목록(문장 ID, 연결된 원문, 검토 필요 여부), 각주를 돌려줍니다.",
    inputSchema: documentInput,
    annotations: read,
  },
  {
    name: "search_project",
    title: "프로젝트 검색",
    description: "프로젝트의 원문과 번역에서 단어나 구절을 찾습니다.",
    inputSchema: {
      type: "object",
      properties: {
        projectId,
        query: { type: "string", description: "찾을 단어나 구절" },
        scope: { type: "string", enum: ["all", "source", "translation"], description: "기본값 all" },
        documentId: { type: "string", description: "한 문서 안에서만 찾을 때" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "기본값 20" },
      },
      required: ["projectId", "query"],
      additionalProperties: false,
    },
    annotations: read,
  },
  {
    name: "get_terms",
    title: "문서 용어",
    description: "문서의 용어 후보와 확정 용어를 돌려줍니다. 용어는 확정 표점본의 위치에 걸리므로, 표점을 확정하지 않은 문서는 ready가 false입니다.",
    inputSchema: documentInput,
    annotations: read,
  },
  {
    name: "list_comments",
    title: "코멘트",
    description: "문서의 원문·번역 구절에 달린 검토 코멘트를 돌려줍니다.",
    inputSchema: documentInput,
    annotations: read,
  },
  {
    name: "get_materials",
    title: "참고 자료",
    description: "이 문서의 번역에 적용되는 참고 자료(문서 설명, 상위 폴더 자료, 사용자가 고른 자료)를 돌려줍니다.",
    inputSchema: documentInput,
    annotations: read,
  },
  {
    name: "get_translation_guide",
    title: "번역 원칙",
    description: "문해가 이 문서를 번역할 때 AI에게 주는 번역 방법, 번역 언어, 번역 원칙, 확정 용어, 포함된 참고 자료를 그대로 돌려줍니다. 번역을 쓰거나 고치기 전에 읽으세요.",
    inputSchema: documentInput,
    annotations: read,
  },
  {
    name: "edit_translation_sentences",
    title: "번역 문장 고치기",
    description: "번역안의 문장을 get_document의 문장 ID로 골라 고칩니다. 원문 연결은 유지됩니다. 바로 반영되고 사용자가 되돌릴 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        projectId, documentId,
        revision: { type: "string", description: "get_document에서 받은 translation.revision" },
        edits: {
          type: "array", minItems: 1, maxItems: 200,
          items: { type: "object", properties: { sentenceId: { type: "string" }, text: { type: "string", description: "고친 문장 전체" } }, required: ["sentenceId", "text"], additionalProperties: false },
        },
      },
      required: ["projectId", "documentId", "revision", "edits"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "replace_translation",
    title: "번역 전문 쓰기",
    description: "번역안 전체를 새 글로 바꿉니다. 번역이 없는 문서에는 새 번역안을 만듭니다. 문장별 원문 연결은 다시 해야 하는 상태가 됩니다. 바로 반영되고 사용자가 되돌릴 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: {
        projectId, documentId,
        revision: { type: "string", description: "번역이 이미 있으면 get_document에서 받은 translation.revision" },
        text: { type: "string", description: "번역 전문. 문단은 빈 줄로 나눕니다." },
      },
      required: ["projectId", "documentId", "text"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "confirm_translation",
    title: "번역 확정",
    description: "번역안을 확정합니다. 편집기의 확정 버튼과 같은 검사를 거칩니다. 사용자가 되돌릴 수 있습니다.",
    inputSchema: {
      type: "object",
      properties: { projectId, documentId, revision: { type: "string", description: "get_document에서 받은 translation.revision" } },
      required: ["projectId", "documentId", "revision"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "add_comment",
    title: "코멘트 달기",
    description: "원문이나 번역의 구절에 검토 코멘트를 답니다. quote는 본문에 그대로 있는 구절이어야 합니다.",
    inputSchema: {
      type: "object",
      properties: {
        projectId, documentId,
        on: { type: "string", enum: ["source", "translation"], description: "source는 표점 전 저장 원문 기준" },
        quote: { type: "string", description: "코멘트를 달 구절" },
        occurrence: { type: "integer", minimum: 1, description: "같은 구절이 여러 번 나올 때 몇 번째인지. 기본값 1" },
        body: { type: "string", description: "코멘트 내용" },
      },
      required: ["projectId", "documentId", "on", "quote", "body"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "propose_terms",
    title: "용어 후보 추가",
    description: "문서에 용어 후보를 더합니다. 기존 후보는 그대로 둡니다. 위치는 확정 표점본에서 sourceForm이 나오는 곳이며, occurrences로 몇 번째 등장만 고를 수 있습니다(기본: 모두).",
    inputSchema: {
      type: "object",
      properties: {
        projectId, documentId,
        terms: {
          type: "array", minItems: 1, maxItems: 100,
          items: {
            type: "object",
            properties: {
              sourceForm: { type: "string", description: "원문에 나오는 그대로의 표기" },
              kind: termKind,
              reading: { type: "string" }, translation: { type: "string" }, definition: { type: "string" },
              contextNote: { type: "string", description: "이 문서에서 가리키는 대상이나 쓰임" },
              ...termJudgment,
              occurrences: { type: "array", items: { type: "integer", minimum: 1 }, description: "몇 번째 등장인지(1부터). 생략하면 모두" },
              evidence: { type: "array", maxItems: 20, items: { type: "object", properties: { citation: { type: "string" }, url: { type: "string" } }, required: ["citation"], additionalProperties: false } },
            },
            required: ["sourceForm", "kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectId", "documentId", "terms"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "confirm_terms",
    title: "용어 확정",
    description: "get_terms의 후보를 그 위치 그대로 확정합니다. 여러 개를 한 번에 처리하고, 하나라도 실패하면 아무것도 바뀌지 않습니다. 확정하면서 독음·번역·뜻·분류를 고칠 수 있습니다(이미 있는 용어에 연결되는 후보는 update_terms로 고치세요).",
    inputSchema: {
      type: "object",
      properties: {
        projectId, documentId,
        candidates: {
          type: "array", minItems: 1, maxItems: 500,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "get_terms의 후보 ID" },
              kind: termKind, reading: { type: "string" }, translation: { type: "string" }, definition: { type: "string" },
              contextNote: { type: "string" }, ...termJudgment,
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectId", "documentId", "candidates"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "dismiss_term_candidates",
    title: "용어 후보 버리기",
    description: "용어 후보를 버립니다. 여러 개를 한 번에 처리합니다.",
    inputSchema: {
      type: "object",
      properties: { projectId, documentId, candidateIds: { type: "array", minItems: 1, maxItems: 500, items: { type: "string" } } },
      required: ["projectId", "documentId", "candidateIds"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "update_terms",
    title: "용어 고치기",
    description: "확정 용어의 독음·번역·뜻·분류를 고칩니다. 프로젝트 용어집 항목이므로 이 용어를 쓰는 다른 문서에도 반영됩니다. 적지 않은 값은 그대로 둡니다.",
    inputSchema: {
      type: "object",
      properties: {
        projectId, documentId,
        terms: {
          type: "array", minItems: 1, maxItems: 200,
          items: {
            type: "object",
            properties: {
              termId: { type: "string", description: "get_terms의 termId" },
              lockVersion: { type: "integer", description: "get_terms의 lockVersion" },
              kind: termKind, reading: { type: "string" }, translation: { type: "string" }, definition: { type: "string" },
            },
            required: ["termId", "lockVersion"],
            additionalProperties: false,
          },
        },
      },
      required: ["projectId", "documentId", "terms"],
      additionalProperties: false,
    },
    annotations: write,
  },
  {
    name: "undo_change",
    title: "되돌리기",
    description: "이 대화에서 만든 변경을 되돌립니다. 쓰기 도구가 돌려준 changeId를 넘깁니다. 그 뒤에 다른 변경이 있었으면 되돌리지 않습니다.",
    inputSchema: {
      type: "object",
      properties: { projectId, changeId: { type: "string" } },
      required: ["projectId", "changeId"],
      additionalProperties: false,
    },
    annotations: write,
  },
];

export function mcpClientLabel(info: { name?: unknown; title?: unknown } | null | undefined): string {
  const name = typeof info?.name === "string" ? info.name.trim().toLowerCase() : "";
  if (name.includes("claude")) return "Claude Code";
  if (name.includes("codex")) return "Codex";
  if (name.includes("antigravity") || name.includes("gemini")) return "Antigravity";
  const title = typeof info?.title === "string" && info.title.trim() ? info.title.trim() : typeof info?.name === "string" ? info.name.trim() : "";
  return title.slice(0, 60) || "AI 도구";
}
