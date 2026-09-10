// Standalone prototype data. These review notes are illustrative decisions,
// not verified historical findings or records from a real project.
export const PROJECT_NODE = { id: "project", title: "관제 문헌 번역" };
export const GROUPS = [
  { id: "ritual", title: "예관", parentId: "project" },
  { id: "civil", title: "인사", parentId: "project" },
];

export const DOCUMENTS = [
  {
    id: "doc-a",
    title: "태상시 관제",
    hanja: "太常寺",
    group: "예관",
    groupId: "ritual",
    sentences: [
      {
        source: "提調公一人卿一人都正下大夫一人僉正上士二人主簿中士二人供奉下士四人",
        translation: "제조(提調)는 공(公) 1명, 경(卿) 1명이고, 도정(都正)은 하대부(下大夫) 1명, 첨정(僉正)은 상사(上士) 2명, 주부(主簿)는 중사(中士) 2명, 공봉(供奉)은 하사(下士) 4명이다.",
      },
      {
        source: "〇書吏十六人皁隷三十人飪夫六十人",
        translation: "서리(書吏)는 16명, 조례(皁隷)는 30명, 임부(飪夫)는 60명이다.",
      },
      {
        source: "臣謹案國朝祭禮專任太常",
        translation: "신이 삼가 살펴보건대, 우리 왕조의 제례(祭禮)는 오로지 태상(太常)에 맡겼습니다.",
      },
    ],
  },
  {
    id: "doc-b",
    title: "태상시 고찰",
    hanja: "太常考",
    group: "예관",
    groupId: "ritual",
    sentences: [
      {
        source: "況議謚進宴所掌皆係尊重",
        translation: "더구나 시호(諡號)를 논의하고 연향(宴享)을 올리는 등 그 관서가 맡은 일은 모두 존엄하고 중대한 일과 관련되어 있습니다.",
      },
    ],
  },
  {
    id: "doc-c",
    title: "정격의 적서 구분",
    hanja: "政格嫡庶",
    group: "인사",
    groupId: "civil",
    sentences: [
      {
        source: "而政格太常之官必以有庶名者差除抑何故也",
        translation: "그런데도 정격(政格)에서는 태상의 관원을 반드시 서얼이라는 명목이 있는 자로 차임(差任)하니, 도대체 무슨 까닭입니까?",
      },
      {
        source: "政格之區別嫡庶本是謬典",
        translation: "정격에서 적서(嫡庶)를 구별한 것부터 본래 잘못된 법전입니다.",
      },
    ],
  },
];

/** Return the exact scope anchor and its ancestors, without a fallback node. */
export function nodePath(scopeType, scopeId) {
  const root = { ...PROJECT_NODE, type: "project" };
  if (scopeType === "project") return scopeId === PROJECT_NODE.id ? [root] : [];
  if (scopeType === "group") {
    const group = GROUPS.find((item) => item.id === scopeId);
    return group ? [root, { id: group.id, title: group.title, type: "group" }] : [];
  }
  if (scopeType === "document") {
    const document = DOCUMENTS.find((item) => item.id === scopeId);
    if (!document) return [];
    const parentPath = nodePath("group", document.groupId);
    return parentPath.length
      ? [...parentPath, { id: document.id, title: document.title, type: "document" }]
      : [];
  }
  return [];
}

export function documentPath(docId) {
  return nodePath("document", docId);
}

export function demoSeed() {
  return {
    materials: [
      {
        id: "material-project-style",
        title: "관원 인원 수의 표기",
        body: "관원의 인원 수는 아라비아 숫자와 ‘명’으로 표기한다. 관직명과 품계는 구별하고, 숫자·인원은 원문과 대조한다.",
        scopeType: "project",
        scopeId: "project",
        origin: "manual",
        sourceCommentId: null,
        condition: "직접 인용한 번역이나 사료의 표기는 원래 표기를 유지한다.",
        createdAt: "2026-09-10T09:00:00.000Z",
      },
      {
        id: "material-project-evidence",
        title: "추정과 확인된 판단의 구분",
        body: "지시 대상이나 제도 명칭을 확정하기 어려우면 단정하지 않는다. 판단을 제안할 때는 해당 구절과 근거, 추가로 확인할 부분을 함께 남긴다.",
        scopeType: "project",
        scopeId: "project",
        origin: "manual",
        sourceCommentId: null,
        condition: "",
        createdAt: "2026-09-10T09:05:00.000Z",
      },
      {
        id: "material-ritual-titles",
        title: "제례 관서의 이름을 옮길 때",
        body: "원문에 적힌 관서 명칭을 우선 보존한다. 다른 정식 명칭으로 풀어 쓸 때는 해당 글에서 같은 관서를 가리킨다는 근거를 확인한다.",
        scopeType: "group",
        scopeId: "ritual",
        origin: "manual",
        sourceCommentId: null,
        condition: "같은 글자의 관서명이 다른 시대나 다른 나라의 제도를 가리킬 수 있으므로 일괄 치환하지 않는다.",
        createdAt: "2026-09-10T09:10:00.000Z",
      },
      {
        id: "material-doc-b-subject",
        title: "고찰문에서 생략된 주체",
        body: "‘所掌’처럼 주체가 생략된 표현은 앞뒤 문장에서 무엇을 가리키는지 대조한다. 번역에서 주체를 보충했다면 보충 근거를 코멘트에 남긴다.",
        scopeType: "document",
        scopeId: "doc-b",
        origin: "manual",
        sourceCommentId: null,
        condition: "문맥에서 주체가 확인될 때만 보충하고, 확인되지 않으면 추정으로 표시한다.",
        createdAt: "2026-09-10T09:15:00.000Z",
      },
    ],
    comments: [
      {
        id: "c1", docId: "doc-a", quote: "公一人卿一人",
        body: "이 문서의 인원 수는 ‘인’ 대신 ‘명’으로 통일합시다. 다만 원문이나 기존 번역을 직접 인용하는 부분은 원래 표기를 유지해야 합니다.",
        status: "open", author: "이현수", date: "오늘 10:24", reusable: false,
      },
      {
        id: "c2", docId: "doc-a", quote: "太常",
        body: "이 글의 ‘太常’이 봉상시를 가리키는지 확인이 필요합니다. 같은 관서라는 근거를 확보하면 이 글의 해당 용례에 한해 설명을 덧붙이고, 다른 시대 관제 인용에는 그대로 적용하지 맙시다.",
        status: "open", author: "이현수", date: "오늘 10:31", reusable: false,
      },
      {
        id: "c3", docId: "doc-b", quote: "所掌",
        body: "이 구절에서 무엇이 그 일을 맡는지 번역만 읽으면 모호했습니다. 앞 구절과 연결해 ‘그 관서가 맡은 일’로 주체를 보충했습니다.",
        status: "resolved", author: "이현수", date: "오늘 10:42", reusable: false,
      },
      {
        id: "c4", docId: "doc-c", quote: "嫡庶",
        body: "‘嫡庶’를 풀어 설명할 때 이 글에서 구별하는 신분의 범위를 먼저 확인합시다. 현대의 가족관계 표현으로 단정하지 말고, 근거가 부족한 해석은 추정으로 남겨 주세요.",
        status: "open", author: "이현수", date: "오늘 10:48", reusable: false,
      },
      {
        id: "c5", docId: "doc-b", quote: "尊重",
        body: "여기서는 ‘존중하다’라는 동작보다 맡은 일의 성격을 말하는지 검토해 주세요. ‘존엄하고 중대한 일’이라는 현재 번역이 앞의 업무 나열과 이어지는지 함께 확인합시다.",
        status: "open", author: "이현수", date: "오늘 10:53", reusable: false,
      },
    ],
    glossary: [
      { id: "glossary-taesang", source: "太常", target: "태상", note: "정식 관서명으로 풀어 쓸 때는 해당 글의 지시 대상을 확인한다.", usage: "기본" },
      { id: "glossary-chaim", source: "差除", target: "차임", note: "독자와 문맥에 따라 ‘임명하다’로 풀어 쓸 수 있다.", usage: "허용" },
      { id: "glossary-jeokseo", source: "嫡庶", target: "정실과 첩", note: "사람의 신분 구분을 배우자 관계로 단정할 수 있어 이 예시에서는 피한다.", usage: "지양" },
    ],
    references: {},
    excluded: {},
  };
}

export function eligibleMaterials(state, docId) {
  const document = DOCUMENTS.find((item) => item.id === docId);
  if (!document) return [];
  const selected = new Set(state.references[docId] ?? []);
  const excluded = new Set(state.excluded[docId] ?? []);
  const seen = new Set();
  const result = [];
  for (const material of state.materials) {
    if (seen.has(material.id)) continue;
    let reason;
    if (material.scopeType === "project") reason = "project";
    else if (material.scopeType === "group" && material.scopeId === document.groupId) reason = "group";
    else if (material.scopeType === "document" && material.scopeId === docId) reason = "direct";
    else if (selected.has(material.id)) reason = "selected";
    if (!reason) continue;
    seen.add(material.id);
    result.push({ ...material, reason, excluded: excluded.has(material.id) });
  }
  return result;
}

export function copyComment(state, { commentId, title, body, condition = "", scopeType, scopeId }) {
  const comment = state.comments.find((item) => item.id === commentId);
  if (!comment) throw new Error("복사할 코멘트를 찾을 수 없습니다.");
  if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !body.trim()) {
    throw new Error("자료의 제목과 내용을 입력해 주세요.");
  }
  if (typeof condition !== "string") throw new Error("적용 조건은 문장으로 입력해 주세요.");
  const validScope = scopeType === "project" && scopeId === "project"
    || scopeType === "group" && DOCUMENTS.some((item) => item.groupId === scopeId)
    || scopeType === "document" && DOCUMENTS.some((item) => item.id === scopeId);
  if (!validScope) throw new Error("자료를 적용할 범위를 선택해 주세요.");
  let sequence = 1;
  const existingIds = new Set(state.materials.map((item) => item.id));
  while (existingIds.has(`material-comment-${sequence}`)) sequence += 1;
  const material = {
    id: `material-comment-${sequence}`,
    title: title.trim(),
    body: body.trim(),
    scopeType,
    scopeId,
    origin: "comment",
    sourceCommentId: comment.id,
    condition: condition.trim(),
    createdAt: new Date().toISOString(),
  };
  state.materials.push(material);
  comment.reusable = true;
  return material;
}
