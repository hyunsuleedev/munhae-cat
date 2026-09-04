import {
  blockTargetRanges,
  canonicalJsonHash,
  codepointCount,
  createId,
  joinBlockTranslations,
  sha256Hex,
  sliceCodepoints,
} from "@munhae/domain";
import type { BootstrappedProject } from "./bootstrap.ts";
import { insertRow } from "./rows.ts";
import type { SqliteDb } from "./sqlite.ts";
import type { BlockDraft } from "./translation.ts";

export const EOJESEO_SOURCE =
  "國之語音異乎中國與文字不相流通故愚民有所欲言而終不得伸其情者多矣予爲此憫然新制二十八字欲使人人易習便於日用耳";

export const EOJESEO_PUNCTUATED =
  "國之語音，異乎中國，與文字不相流通，故愚民有所欲言，而終不得伸其情者多矣。予爲此憫然，新制二十八字，欲使人人易習，便於日用耳。";

export const EOJESEO_ANCHORS = [
  { key: "A001", text: "國之語音，", kind: "clause", sent: 1 },
  { key: "A002", text: "異乎中國，與文字不相流通，", kind: "clause", sent: 1 },
  { key: "A003", text: "故愚民有所欲言，而終不得伸其情者多矣。", kind: "sentence", sent: 1 },
  { key: "A004", text: "予爲此憫然，", kind: "clause", sent: 2 },
  { key: "A005", text: "新制二十八字，", kind: "clause", sent: 2 },
  { key: "A006", text: "欲使人人易習，便於日用耳。", kind: "sentence", sent: 2 },
] as const;

export const LITERAL_V2_BLOCKS: BlockDraft[] = [
  {
    blockKey: "b1",
    blockKind: "paragraph",
    translation: "나라의 말소리가 중국(中國)과 달라 문자(文字)와 서로 통하지 않는다.",
    sourceAnchorIds: ["A001", "A002"],
  },
  {
    blockKey: "b2",
    blockKind: "paragraph",
    translation: "그러므로 어리석은 백성이 말하고자 하는 바가 있어도 끝내 그 뜻을 펴지 못하는 이가 많다.",
    sourceAnchorIds: ["A003"],
  },
  {
    blockKey: "b3",
    blockKind: "paragraph",
    translation: "내가 이를 가엾게 여겨 새로 스물여덟 자를 만들었으니,",
    sourceAnchorIds: ["A004", "A005"],
  },
  {
    blockKey: "b4",
    blockKind: "paragraph",
    translation: "사람마다 쉽게 익혀 날마다 쓰기에 편하게 하고자 할 뿐이다.",
    sourceAnchorIds: ["A006"],
  },
];

export const LITERAL_V1_TEXT =
  "나라의 말소리가 중국(中國)과 달라서 문자(文字)와는 서로 통하지 않는다. 그러므로 어리석은 백성이 말하고자 하는 바가 있어도 끝내 그 뜻을 펴지 못하는 이가 많다. 내가 이를 가엾게 여겨 새로 스물여덟 글자를 만들었으니, 사람마다 쉽게 익혀 날마다 쓰기에 편하게 하고자 할 뿐이다.";

export const READER_BLOCKS: BlockDraft[] = [
  {
    blockKey: "b1",
    blockKind: "paragraph",
    translation:
      "우리나라 말은 중국(中國)과 달라 한자(文字)로는 서로 통하지 않는다. 그래서 글을 모르는 백성은 하고 싶은 말이 있어도 끝내 제 뜻을 펴지 못하는 이가 많다.",
    sourceAnchorIds: ["A001", "A002", "A003"],
  },
  {
    blockKey: "b2",
    blockKind: "paragraph",
    translation:
      "내가 이를 가엾게 여겨 새로 스물여덟 자를 만들었으니, 누구나 쉽게 익혀 날마다 쓰기에 편하도록 하려는 것뿐이다.",
    sourceAnchorIds: ["A004", "A005", "A006"],
  },
];

type NodeSpec = {
  id: string;
  parentId: string | null;
  role?: "container" | "source_unit";
  isMaster?: boolean;
  kind: string;
  title: string;
  originalTitle: string | null;
  ordinal: number;
  genre: string | null;
  authorId: string | null;
  language: string | null;
  periodText: string | null;
  descriptionMd?: string | null;
  sourceReference: string | null;
};

export function seedDemoContents(boot: BootstrappedProject): void {
  const { db, projectId, actors, policyVersionId } = boot;
  const t = {
    person: "2026-08-20T00:00:00.000Z",
    nodes: "2026-08-21T00:00:00.000Z",
    ye: "2026-08-30T09:00:00.000Z",
    jeong: "2026-08-31T12:00:00.000Z",
    v1: "2026-09-01T14:02:00.000Z",
    v2: "2026-09-01T15:40:00.000Z",
  };

  const sejongId = createId();
  const jeongId = createId();
  insertPerson(db, projectId, actors.humanId, t.person, {
    id: sejongId,
    preferred: "世宗",
    hanja: "世宗",
    reading: "세종",
    aliases: ["李祹"],
    dates: "1397–1450",
    desc: "조선 제4대 왕. 1443년 훈민정음 창제, 1446년 반포. 御製序의 저자.",
  });
  insertPerson(db, projectId, actors.humanId, t.person, {
    id: jeongId,
    preferred: "鄭麟趾",
    hanja: "鄭麟趾",
    reading: "정인지",
    aliases: ["學易齋"],
    dates: "1396–1478",
    desc: "解例本 서문 집필. 집현전 학사.",
  });
  for (const p of [
    {
      preferred: "申叔舟",
      hanja: "申叔舟",
      reading: "신숙주",
      aliases: [] as string[],
      dates: "1417–1475",
      desc: "解例 편찬 참여.",
    },
    {
      preferred: "成三問",
      hanja: "成三問",
      reading: "성삼문",
      aliases: [],
      dates: "1418–1456",
      desc: "解例 편찬 참여.",
    },
    {
      preferred: "崔萬理",
      hanja: "崔萬理",
      reading: "최만리",
      aliases: [],
      dates: "?–1445",
      desc: "1444년 諺文 창제 반대 상소. 『世宗實錄』 기사에 등장.",
    },
  ]) {
    insertPerson(db, projectId, actors.humanId, t.person, { id: createId(), ...p });
  }

  const placeId = createId();
  insertRow(db, "places", {
    id: placeId,
    project_id: projectId,
    preferred_name: "中國",
    hanja_name: "中國",
    reading: "중국",
    aliases_json: JSON.stringify(["명"]),
    place_kind: "country",
    location_note_md: "御製序의 中國은 명(明)을 가리킴.",
    description_md: "용어집 항목과 함께 문맥에 포함.",
    content_hash: sha256Hex("中國"),
    lock_version: 1,
    created_by_actor_id: actors.humanId,
    updated_by_actor_id: actors.humanId,
    created_at: t.person,
    updated_at: t.person,
    archived_at: null,
  });

  const masterId = createId();
  const w1 = createId();
  const d1 = createId();
  const d2 = createId();
  const c1 = createId();
  const d3 = createId();
  const d4 = createId();
  const d5 = createId();
  const d6 = createId();
  const d7 = createId();
  const d8 = createId();
  const d9 = createId();
  const w2 = createId();

  const nodes: NodeSpec[] = [
    {
      id: masterId,
      parentId: null,
      role: "container",
      isMaster: true,
      kind: "collection",
      title: boot.title,
      originalTitle: null,
      ordinal: 0,
      genre: null,
      authorId: null,
      language: "lzh",
      periodText: null,
      sourceReference: null,
    },
    {
      id: w1,
      parentId: masterId,
      kind: "work",
      title: "『訓民正音』 解例本",
      originalTitle: "訓民正音 解例本",
      ordinal: 0,
      genre: null,
      authorId: sejongId,
      language: "lzh",
      periodText: "1446",
      descriptionMd: "훈민정음 해례본 전체에 공통으로 적용할 작품 설명.",
      sourceReference: "훈민정음 해례본",
    },
    {
      id: d1,
      parentId: w1,
      role: "source_unit",
      kind: "section",
      title: "御製序",
      originalTitle: "御製序",
      ordinal: 0,
      genre: "preface",
      authorId: null,
      language: null,
      periodText: null,
      descriptionMd: "어제서 번역에만 적용할 현재 문서 설명.",
      sourceReference: null,
    },
    {
      id: d2,
      parentId: w1,
      role: "source_unit",
      kind: "section",
      title: "例義",
      originalTitle: "例義",
      ordinal: 1,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: c1,
      parentId: w1,
      kind: "chapter",
      title: "解例",
      originalTitle: "解例",
      ordinal: 2,
      genre: null,
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d3,
      parentId: c1,
      role: "source_unit",
      kind: "section",
      title: "制字解",
      originalTitle: "制字解",
      ordinal: 0,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d4,
      parentId: c1,
      role: "source_unit",
      kind: "section",
      title: "初聲解",
      originalTitle: "初聲解",
      ordinal: 1,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d5,
      parentId: c1,
      role: "source_unit",
      kind: "section",
      title: "中聲解",
      originalTitle: "中聲解",
      ordinal: 2,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d6,
      parentId: c1,
      kind: "section",
      title: "終聲解",
      originalTitle: "終聲解",
      ordinal: 3,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d7,
      parentId: c1,
      kind: "section",
      title: "合字解",
      originalTitle: "合字解",
      ordinal: 4,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d8,
      parentId: c1,
      kind: "section",
      title: "用字例",
      originalTitle: "用字例",
      ordinal: 5,
      genre: "prose",
      authorId: null,
      language: null,
      periodText: null,
      sourceReference: null,
    },
    {
      id: d9,
      parentId: w1,
      role: "source_unit",
      kind: "section",
      title: "鄭麟趾 序",
      originalTitle: "鄭麟趾 序",
      ordinal: 3,
      genre: "preface",
      authorId: jeongId,
      language: null,
      periodText: null,
      descriptionMd: "정인지 서문에만 적용할 설명.",
      sourceReference: null,
    },
    {
      id: w2,
      parentId: masterId,
      role: "source_unit",
      kind: "volume",
      title: "『世宗實錄』 卷113",
      originalTitle: "世宗實錄 卷113",
      ordinal: 1,
      genre: "official_document",
      authorId: null,
      language: "lzh",
      periodText: "1446",
      sourceReference: "조선왕조실록",
    },
  ];
  for (const n of nodes) insertNode(db, projectId, t.nodes, n);

  insertRow(db, "core_project_settings", {
    project_id: projectId,
    active_document_node_id: d1,
    autosave_interval_ms: 3000,
    ai_data_policy_json: JSON.stringify({ storePrompts: false }),
    settings_json: JSON.stringify({ demo: true }),
    lock_version: 1,
  });

  const eojeseo = seedSourcePunctuationAnchors({
    db,
    projectId,
    actors,
    policyVersionId,
    nodeId: d1,
    name: "御製序 원문",
    source: EOJESEO_SOURCE,
    punctuated: EOJESEO_PUNCTUATED,
    confirmed: true,
    origin: "import",
    createdAt: t.v1,
    anchors: EOJESEO_ANCHORS.map((a) => ({ key: a.key, text: a.text, kind: a.kind, sent: a.sent })),
  });

  const yeui = seedSimpleDocument({
    db,
    projectId,
    actors,
    policyVersionId,
    nodeId: d2,
    name: "例義",
    source: "正音之作",
    punctuated: "正音之作。",
    confirmedSource: true,
    confirmedPunc: true,
    createdAt: t.ye,
    translation: {
      stage: "literal",
      text: "정음(正音)을 지은 까닭이다.",
      blocks: [
        {
          blockKey: "b1",
          blockKind: "paragraph",
          translation: "정음(正音)을 지은 까닭이다.",
          sourceAnchorIds: ["A001"],
        },
      ],
      confirmed: true,
      origin: "human",
      versionNo: 3,
    },
  });

  seedSimpleDocument({
    db,
    projectId,
    actors,
    policyVersionId,
    nodeId: d3,
    name: "制字解",
    source: "天地之道",
    punctuated: "天地之道。",
    confirmedSource: true,
    confirmedPunc: false,
    createdAt: t.nodes,
  });
  seedSourceOnly(db, projectId, actors, d4, "初聲解", "初聲之制", true, t.nodes);
  seedSourceOnly(db, projectId, actors, d5, "中聲解", "中聲之制", false, t.nodes);

  const jeong = seedSimpleDocument({
    db,
    projectId,
    actors,
    policyVersionId,
    nodeId: d9,
    name: "鄭麟趾 序",
    source: "正音作而集賢殿學士",
    punctuated: "正音作而，集賢殿學士。",
    confirmedSource: true,
    confirmedPunc: true,
    createdAt: t.jeong,
    translation: {
      stage: "literal",
      text: "정음이 만들어지고 집현전 학사들이…",
      blocks: [
        {
          blockKey: "b1",
          blockKind: "paragraph",
          translation: "정음이 만들어지고 집현전 학사들이…",
          sourceAnchorIds: ["A001"],
        },
      ],
      confirmed: false,
      origin: "ai",
      versionNo: 1,
      needsReview: true,
    },
  });

  seedSimpleDocument({
    db,
    projectId,
    actors,
    policyVersionId,
    nodeId: w2,
    name: "世宗實錄",
    source: "是月上親制諺文二十八字",
    punctuated: "是月，上親制諺文二十八字。",
    confirmedSource: true,
    confirmedPunc: false,
    createdAt: t.nodes,
  });

  const threadId = createId();
  const userMsgId = createId();
  const asstMsgId = createId();
  insertRow(db, "chat_threads", {
    id: threadId,
    project_id: projectId,
    title: "御製序 번역",
    scope_kind: "document_node",
    scope_id: d1,
    created_by_actor_id: actors.humanId,
    created_at: t.v1,
  });
  insertRow(db, "chat_messages", {
    id: userMsgId,
    project_id: projectId,
    thread_id: threadId,
    parent_message_id: null,
    role: "user",
    actor_id: actors.humanId,
    state: "complete",
    agent_id: null,
    task_kind: "chat",
    output_validation_state: "not_applicable",
    created_at: t.v1,
  });
  insertRow(db, "chat_message_parts", {
    id: createId(),
    project_id: projectId,
    message_id: userMsgId,
    ordinal: 1,
    part_kind: "text",
    text_content: "御製序를 직역안과 독자안으로 번역해 주세요.",
    structured_json: null,
    artifact_id: null,
  });
  insertRow(db, "chat_messages", {
    id: asstMsgId,
    project_id: projectId,
    thread_id: threadId,
    parent_message_id: userMsgId,
    role: "assistant",
    actor_id: actors.llmId,
    state: "complete",
    agent_id: "claude",
    requested_model: "default",
    resolved_model: "default",
    task_kind: "translation",
    output_contract: "translation-envelope.v1",
    output_validation_state: "valid",
    created_at: t.v1,
  });
  insertRow(db, "chat_message_parts", {
    id: createId(),
    project_id: projectId,
    message_id: asstMsgId,
    ordinal: 1,
    part_kind: "text",
    text_content: "직역안과 독자안을 제출했습니다. 일반 채팅은 번역 데이터를 변경하지 않습니다.",
    structured_json: null,
    artifact_id: null,
  });

  const literalId = createId();
  insertRow(db, "document_translations", {
    id: literalId,
    project_id: projectId,
    document_node_id: d1,
    source_text_id: eojeseo.sourceTextId,
    target_locale: "ko",
    stage: "literal",
    created_at: t.v1,
    tombstoned_at: null,
  });
  const v1Id = createId();
  insertTranslationVersion(db, {
    id: v1Id,
    projectId,
    translationId: literalId,
    parentId: null,
    versionNo: 1,
    sourceVersionId: eojeseo.sourceVersionId,
    puncVersionId: eojeseo.puncVersionId,
    anchorSetId: eojeseo.anchorSetId,
    policyVersionId,
    text: LITERAL_V1_TEXT,
    origin: "ai",
    messageId: asstMsgId,
    candidateKey: "literal",
    validationState: "valid",
    state: "superseded",
    actorId: actors.llmId,
    createdAt: t.v1,
    blocks: [
      {
        blockKey: "b1",
        blockKind: "paragraph",
        translation: LITERAL_V1_TEXT,
        sourceAnchorIds: ["A001", "A002", "A003", "A004", "A005", "A006"],
      },
    ],
    anchors: eojeseo.anchors,
  });
  const v2Id = createId();
  insertTranslationVersion(db, {
    id: v2Id,
    projectId,
    translationId: literalId,
    parentId: v1Id,
    versionNo: 2,
    sourceVersionId: eojeseo.sourceVersionId,
    puncVersionId: eojeseo.puncVersionId,
    anchorSetId: eojeseo.anchorSetId,
    policyVersionId,
    text: joinBlockTranslations(LITERAL_V2_BLOCKS.map((b) => b.translation)),
    origin: "human",
    messageId: null,
    candidateKey: null,
    validationState: "valid",
    state: "draft",
    actorId: actors.humanId,
    createdAt: t.v2,
    blocks: LITERAL_V2_BLOCKS,
    anchors: eojeseo.anchors,
  });
  insertRow(db, "document_translation_heads", {
    project_id: projectId,
    document_translation_id: literalId,
    current_version_id: v2Id,
    confirmed_version_id: null,
    lock_version: 2,
    updated_at: t.v2,
  });
  insertRow(db, "user_edits", {
    id: createId(),
    project_id: projectId,
    document_translation_id: literalId,
    base_document_translation_version_id: v1Id,
    result_document_translation_version_id: v2Id,
    edit_kind: "user_edit",
    reason: "b1 어순 정리, b3 ‘글자’→‘자’",
    actor_id: actors.humanId,
    created_at: t.v2,
  });

  const readerId = createId();
  insertRow(db, "document_translations", {
    id: readerId,
    project_id: projectId,
    document_node_id: d1,
    source_text_id: eojeseo.sourceTextId,
    target_locale: "ko",
    stage: "reader",
    created_at: t.v1,
    tombstoned_at: null,
  });
  const readerVid = createId();
  insertTranslationVersion(db, {
    id: readerVid,
    projectId,
    translationId: readerId,
    parentId: null,
    versionNo: 1,
    sourceVersionId: eojeseo.sourceVersionId,
    puncVersionId: eojeseo.puncVersionId,
    anchorSetId: eojeseo.anchorSetId,
    policyVersionId,
    text: joinBlockTranslations(READER_BLOCKS.map((b) => b.translation)),
    origin: "ai",
    messageId: asstMsgId,
    candidateKey: "reader",
    validationState: "valid",
    state: "draft",
    actorId: actors.llmId,
    createdAt: t.v1,
    blocks: READER_BLOCKS,
    anchors: eojeseo.anchors,
  });
  insertRow(db, "document_translation_heads", {
    project_id: projectId,
    document_translation_id: readerId,
    current_version_id: readerVid,
    confirmed_version_id: null,
    lock_version: 1,
    updated_at: t.v1,
  });

  const reportId = createId();
  insertRow(db, "reflection_reports", {
    id: reportId,
    project_id: projectId,
    source_message_id: asstMsgId,
    reflection_kind: "translation-envelope",
    verdict: "pass_with_warnings",
    summary_md: "원문 누락 없음. 독자안의 文字 대응어와 愚民 해석을 검토하세요.",
    content_hash: sha256Hex("reflection-eojeseo"),
    created_at: t.v1,
  });
  insertRow(db, "reflection_report_translation_versions", {
    project_id: projectId,
    report_id: reportId,
    document_translation_version_id: v1Id,
    ordinal: 1,
  });
  insertRow(db, "reflection_report_translation_versions", {
    project_id: projectId,
    report_id: reportId,
    document_translation_version_id: readerVid,
    ordinal: 2,
  });
  const f1 = createId();
  const f2 = createId();
  const f3 = createId();
  insertRow(db, "reflection_findings", {
    id: f1,
    project_id: projectId,
    report_id: reportId,
    document_translation_version_id: readerVid,
    finding_kind: "term_consistency",
    severity: "warning",
    explanation_md:
      "文字를 ‘한자(文字)’로 옮겼습니다. 용어집의 preferred 대응어는 ‘문자(文字)’입니다. 의도한 선택이면 allowed 항목을 추가하세요.",
    resolution_state: "open",
  });
  insertRow(db, "reflection_findings", {
    id: f2,
    project_id: projectId,
    report_id: reportId,
    document_translation_version_id: null,
    finding_kind: "interpretive_uncertainty",
    severity: "info",
    explanation_md:
      "愚民의 愚는 ‘어리석은’과 ‘글을 모르는’ 두 해석이 있습니다. 열린 불확실성 U-02와 연결되어 있으며 원문 밖 정보는 삽입하지 않았습니다.",
    resolution_state: "open",
  });
  insertRow(db, "reflection_findings", {
    id: f3,
    project_id: projectId,
    report_id: reportId,
    document_translation_version_id: null,
    finding_kind: "coverage",
    severity: "pass",
    explanation_md: "원문 누락 없음 — 두 번역안 모두 required 앵커 6개를 순서대로 한 번씩 연결했습니다.",
    resolution_state: "open",
  });
  const a002 = eojeseo.anchors.find((a) => a.key === "A002");
  const a003 = eojeseo.anchors.find((a) => a.key === "A003");
  if (a002) {
    insertRow(db, "reflection_finding_anchors", {
      project_id: projectId,
      finding_id: f1,
      translation_anchor_id: a002.id,
      ordinal: 1,
    });
  }
  if (a003) {
    insertRow(db, "reflection_finding_anchors", {
      project_id: projectId,
      finding_id: f2,
      translation_anchor_id: a003.id,
      ordinal: 1,
    });
  }

  seedGlossary(db, projectId, actors.humanId, t.person);
  seedUncertainties(db, projectId, actors.humanId, eojeseo.anchors, d1, d9, t.v1);
  insertRow(db, "context_items", {
    id: createId(),
    project_id: projectId,
    item_kind: "period_background",
    scope_kind: "document_node",
    scope_id: masterId,
    title: "창제·반포 배경",
    content_md: "1443년 창제, 1446년 반포. 御製序는 世宗이 지은 서문이다.",
    priority: 10,
    enabled: 1,
    content_hash: sha256Hex("period_background"),
    created_at: t.nodes,
    updated_at: t.nodes,
    archived_at: null,
  });
  for (const item of [
    {
      id: createId(),
      scopeId: d1,
      title: "어제서 번역 지침",
      content: "어제서의 화자는 세종이며 현재 node에서 가장 먼저 적용한다.",
      priority: 30,
    },
    {
      id: createId(),
      scopeId: w1,
      title: "해례본 공통 문체",
      content: "해례본 하위 node에 적용하는 작품 범위 문체 지침.",
      priority: 20,
    },
    {
      id: createId(),
      scopeId: d9,
      title: "정인지 서문 전용",
      content: "이 카드는 어제서와 다른 가지이므로 자동 포함하지 않는다.",
      priority: 99,
    },
  ]) {
    insertRow(db, "context_items", {
      id: item.id,
      project_id: projectId,
      item_kind: "style_instruction",
      scope_kind: "document_node",
      scope_id: item.scopeId,
      title: item.title,
      content_md: item.content,
      priority: item.priority,
      enabled: 1,
      content_hash: sha256Hex(item.content),
      created_at: t.nodes,
      updated_at: t.nodes,
      archived_at: null,
    });
  }

  void yeui;
  void jeong;
}

function insertPerson(
  db: SqliteDb,
  projectId: string,
  actorId: string,
  createdAt: string,
  p: {
    id: string;
    preferred: string;
    hanja: string;
    reading: string;
    aliases: string[];
    dates: string;
    desc: string;
  },
): void {
  insertRow(db, "persons", {
    id: p.id,
    project_id: projectId,
    preferred_name: p.preferred,
    hanja_name: p.hanja,
    reading: p.reading,
    aliases_json: JSON.stringify(p.aliases),
    description_md: p.desc,
    date_text: p.dates,
    content_hash: sha256Hex(p.preferred),
    lock_version: 1,
    created_by_actor_id: actorId,
    updated_by_actor_id: actorId,
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
  });
}

function insertNode(db: SqliteDb, projectId: string, createdAt: string, n: NodeSpec): void {
  insertRow(db, "document_nodes", {
    id: n.id,
    project_id: projectId,
    parent_node_id: n.parentId,
    node_role: n.role ?? "container",
    is_master: n.isMaster ? 1 : 0,
    structural_kind: n.kind,
    title: n.title,
    original_title: n.originalTitle,
    ordinal: n.ordinal,
    genre: n.genre,
    author_person_id: n.authorId,
    language: n.language,
    period_text: n.periodText,
    date_text: null,
    description_md: n.descriptionMd ?? null,
    source_reference: n.sourceReference,
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
  });
}

function seedSourceOnly(
  db: SqliteDb,
  projectId: string,
  actors: BootstrappedProject["actors"],
  nodeId: string,
  name: string,
  source: string,
  confirmed: boolean,
  createdAt: string,
): void {
  const sourceTextId = createId();
  const versionId = createId();
  insertRow(db, "src_texts", {
    id: sourceTextId,
    project_id: projectId,
    document_node_id: nodeId,
    name,
    status: "active",
    created_at: createdAt,
    tombstoned_at: null,
  });
  insertRow(db, "src_text_versions", {
    id: versionId,
    project_id: projectId,
    source_text_id: sourceTextId,
    parent_version_id: null,
    version_no: 1,
    content_text: source,
    origin_kind: "paste",
    source_asset_id: null,
    change_summary: null,
    state: confirmed ? "confirmed" : "draft",
    content_hash: sha256Hex(source),
    created_by_actor_id: actors.humanId,
    created_at: createdAt,
  });
  insertRow(db, "src_text_heads", {
    project_id: projectId,
    source_text_id: sourceTextId,
    current_version_id: versionId,
    confirmed_version_id: confirmed ? versionId : null,
    lock_version: 1,
    updated_at: createdAt,
  });
}

type AnchorRec = { id: string; key: string; ordinal: number; required: number };

function seedSourcePunctuationAnchors(opts: {
  db: SqliteDb;
  projectId: string;
  actors: BootstrappedProject["actors"];
  policyVersionId: string;
  nodeId: string;
  name: string;
  source: string;
  punctuated: string;
  confirmed: boolean;
  origin: "paste" | "import" | "manual";
  createdAt: string;
  anchors: Array<{ key: string; text: string; kind: string; sent: number }>;
}): {
  sourceTextId: string;
  sourceVersionId: string;
  puncVersionId: string;
  anchorSetId: string;
  anchors: AnchorRec[];
} {
  const { db, projectId, actors } = opts;
  const sourceTextId = createId();
  const sourceVersionId = createId();
  insertRow(db, "src_texts", {
    id: sourceTextId,
    project_id: projectId,
    document_node_id: opts.nodeId,
    name: opts.name,
    status: "active",
    created_at: opts.createdAt,
    tombstoned_at: null,
  });
  insertRow(db, "src_text_versions", {
    id: sourceVersionId,
    project_id: projectId,
    source_text_id: sourceTextId,
    parent_version_id: null,
    version_no: 1,
    content_text: opts.source,
    origin_kind: opts.origin,
    source_asset_id: null,
    change_summary: null,
    state: opts.confirmed ? "confirmed" : "draft",
    content_hash: sha256Hex(opts.source),
    created_by_actor_id: actors.humanId,
    created_at: opts.createdAt,
  });
  insertRow(db, "src_text_heads", {
    project_id: projectId,
    source_text_id: sourceTextId,
    current_version_id: sourceVersionId,
    confirmed_version_id: opts.confirmed ? sourceVersionId : null,
    lock_version: 1,
    updated_at: opts.createdAt,
  });

  const setId = createId();
  const puncVersionId = createId();
  const spanManifest = opts.anchors.map((a, i) => ({
    spanKind: a.kind,
    ordinal: i + 1,
    quote: a.text,
  }));
  const puncHash = canonicalJsonHash({ punctuatedText: opts.punctuated, spans: spanManifest });
  insertRow(db, "punctuation_sets", {
    id: setId,
    project_id: projectId,
    source_text_id: sourceTextId,
    name: `${opts.name} 표점`,
    policy_version_id: opts.policyVersionId,
    status: "active",
    created_at: opts.createdAt,
  });
  insertRow(db, "punctuation_versions", {
    id: puncVersionId,
    project_id: projectId,
    punctuation_set_id: setId,
    source_text_version_id: sourceVersionId,
    parent_version_id: null,
    version_no: 1,
    punctuated_text: opts.punctuated,
    structure_json: JSON.stringify({ kind: "prose" }),
    change_summary: null,
    state: opts.confirmed ? "confirmed" : "draft",
    content_hash: puncHash,
    created_by_actor_id: actors.humanId,
    created_at: opts.createdAt,
  });
  insertRow(db, "punctuation_heads", {
    project_id: projectId,
    punctuation_set_id: setId,
    current_version_id: puncVersionId,
    confirmed_version_id: opts.confirmed ? puncVersionId : null,
    lock_version: 1,
    updated_at: opts.createdAt,
  });

  const paraId = createId();
  const fullLen = codepointCount(opts.punctuated);
  insertSpan(db, projectId, puncVersionId, actors.humanId, opts.createdAt, {
    id: paraId,
    kind: "paragraph",
    parent: null,
    ordinal: 1,
    from: 0,
    to: fullLen,
    quote: opts.punctuated,
  });
  const sentIds: Record<number, string> = {};
  const bySent = new Map<number, typeof opts.anchors>();
  for (const a of opts.anchors) {
    const list = bySent.get(a.sent) ?? [];
    list.push(a);
    bySent.set(a.sent, list);
  }
  let sentOrd = 1;
  let cursor = 0;
  for (const [sent, list] of [...bySent.entries()].sort((a, b) => a[0] - b[0])) {
    const quote = list.map((x) => x.text).join("");
    const from = cursor;
    const to = from + codepointCount(quote);
    const sid = createId();
    sentIds[sent] = sid;
    insertSpan(db, projectId, puncVersionId, actors.humanId, opts.createdAt, {
      id: sid,
      kind: "sentence",
      parent: paraId,
      ordinal: sentOrd,
      from,
      to,
      quote,
    });
    sentOrd += 1;
    cursor = to;
  }

  const mapped = mapAnchors(opts.source, opts.punctuated, opts.anchors);
  const anchorSetId = createId();
  const hash = canonicalJsonHash({
    sourceTextVersionId: sourceVersionId,
    punctuationVersionId: puncVersionId,
    strategyKey: "sentence-clause-v1",
    strategyVersion: 1,
    coveragePolicy: "full_text",
    anchors: mapped.map((a) => ({
      anchorKey: a.key,
      ordinal: a.ordinal,
      boundaryKind: a.kind,
      punctuationFrom: a.pFrom,
      punctuationTo: a.pTo,
      punctuatedQuoteHash: sha256Hex(a.text),
      sourceFrom: a.sFrom,
      sourceTo: a.sTo,
      sourceQuoteHash: sha256Hex(a.sourceQuote),
    })),
  });
  insertRow(db, "translation_anchor_sets", {
    id: anchorSetId,
    project_id: projectId,
    document_node_id: opts.nodeId,
    source_text_version_id: sourceVersionId,
    punctuation_version_id: puncVersionId,
    strategy_key: "sentence-clause-v1",
    strategy_version: 1,
    coverage_policy: "full_text",
    anchor_set_hash: hash,
    created_by_actor_id: actors.systemId,
    created_at: opts.createdAt,
  });
  const recs: AnchorRec[] = [];
  for (const a of mapped) {
    const id = createId();
    insertRow(db, "translation_anchors", {
      id,
      project_id: projectId,
      anchor_set_id: anchorSetId,
      anchor_key: a.key,
      ordinal: a.ordinal,
      boundary_kind: a.kind,
      punctuation_codepoint_from: a.pFrom,
      punctuation_codepoint_to: a.pTo,
      punctuated_quote: a.text,
      punctuated_quote_hash: sha256Hex(a.text),
      source_codepoint_from: a.sFrom,
      source_codepoint_to: a.sTo,
      source_quote: a.sourceQuote,
      source_quote_hash: sha256Hex(a.sourceQuote),
      context_before_hash: null,
      context_after_hash: null,
      display_label: a.key,
      required: 1,
      created_at: opts.createdAt,
    });
    recs.push({ id, key: a.key, ordinal: a.ordinal, required: 1 });
    const sentId = sentIds[a.sent];
    if (sentId) {
      insertRow(db, "translation_anchor_structure_spans", {
        project_id: projectId,
        anchor_id: id,
        punctuation_structure_span_id: sentId,
        ordinal: 1,
      });
    }
    insertRow(db, "translation_anchor_structure_spans", {
      project_id: projectId,
      anchor_id: id,
      punctuation_structure_span_id: paraId,
      ordinal: 2,
    });
  }

  return { sourceTextId, sourceVersionId, puncVersionId, anchorSetId, anchors: recs };
}

function seedSimpleDocument(opts: {
  db: SqliteDb;
  projectId: string;
  actors: BootstrappedProject["actors"];
  policyVersionId: string;
  nodeId: string;
  name: string;
  source: string;
  punctuated: string;
  confirmedSource: boolean;
  confirmedPunc: boolean;
  createdAt: string;
  translation?: {
    stage: string;
    text: string;
    blocks: BlockDraft[];
    confirmed: boolean;
    origin: string;
    versionNo: number;
    needsReview?: boolean;
  };
}): { sourceTextId: string; anchors: AnchorRec[] } {
  const chain = seedSourcePunctuationAnchors({
    db: opts.db,
    projectId: opts.projectId,
    actors: opts.actors,
    policyVersionId: opts.policyVersionId,
    nodeId: opts.nodeId,
    name: opts.name,
    source: opts.source,
    punctuated: opts.punctuated,
    confirmed: opts.confirmedSource,
    origin: "paste",
    createdAt: opts.createdAt,
    anchors: [{ key: "A001", text: opts.punctuated, kind: "sentence", sent: 1 }],
  });
  if (!opts.confirmedPunc) {
    opts.db
      .prepare(`UPDATE punctuation_versions SET state = 'draft' WHERE id = ?`)
      .run(chain.puncVersionId);
    opts.db
      .prepare(`UPDATE punctuation_heads SET confirmed_version_id = NULL WHERE current_version_id = ?`)
      .run(chain.puncVersionId);
  }
  if (opts.translation) {
    const trId = createId();
    const vid = createId();
    insertRow(opts.db, "document_translations", {
      id: trId,
      project_id: opts.projectId,
      document_node_id: opts.nodeId,
      source_text_id: chain.sourceTextId,
      target_locale: "ko",
      stage: opts.translation.stage,
      created_at: opts.createdAt,
      tombstoned_at: null,
    });
    insertTranslationVersion(opts.db, {
      id: vid,
      projectId: opts.projectId,
      translationId: trId,
      parentId: null,
      versionNo: opts.translation.versionNo,
      sourceVersionId: chain.sourceVersionId,
      puncVersionId: chain.puncVersionId,
      anchorSetId: chain.anchorSetId,
      policyVersionId: opts.policyVersionId,
      text: opts.translation.text,
      origin: opts.translation.origin,
      messageId: null,
      candidateKey: null,
      validationState: opts.translation.needsReview ? "needs_review" : "valid",
      state: opts.translation.confirmed ? "confirmed" : "draft",
      actorId: opts.translation.origin === "ai" ? opts.actors.llmId : opts.actors.humanId,
      createdAt: opts.createdAt,
      blocks: opts.translation.blocks,
      anchors: chain.anchors,
    });
    insertRow(opts.db, "document_translation_heads", {
      project_id: opts.projectId,
      document_translation_id: trId,
      current_version_id: vid,
      confirmed_version_id: opts.translation.confirmed ? vid : null,
      lock_version: 1,
      updated_at: opts.createdAt,
    });
  }
  return { sourceTextId: chain.sourceTextId, anchors: chain.anchors };
}

function insertSpan(
  db: SqliteDb,
  projectId: string,
  puncVersionId: string,
  actorId: string,
  createdAt: string,
  s: { id: string; kind: string; parent: string | null; ordinal: number; from: number; to: number; quote: string },
): void {
  insertRow(db, "punctuation_structure_spans", {
    id: s.id,
    project_id: projectId,
    punctuation_version_id: puncVersionId,
    span_kind: s.kind,
    parent_span_id: s.parent,
    ordinal: s.ordinal,
    codepoint_from: s.from,
    codepoint_to: s.to,
    quote: s.quote,
    quote_hash: sha256Hex(s.quote),
    origin_kind: "manual",
    confidence: null,
    label: s.kind,
    created_by_actor_id: actorId,
    created_at: createdAt,
  });
}

function mapAnchors(
  source: string,
  punctuated: string,
  anchors: Array<{ key: string; text: string; kind: string; sent: number }>,
): Array<{
  key: string;
  text: string;
  kind: string;
  sent: number;
  ordinal: number;
  pFrom: number;
  pTo: number;
  sFrom: number;
  sTo: number;
  sourceQuote: string;
}> {
  const joined = anchors.map((a) => a.text).join("");
  if (joined !== punctuated) {
    throw new Error("demo anchors do not concatenate to punctuated text");
  }
  let pCursor = 0;
  let sCursor = 0;
  const pChars = Array.from(punctuated);
  const sChars = Array.from(source);
  const isPunc = (ch: string) => ch === "，" || ch === "。" || ch === "、" || ch === "；";
  const out = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const a = anchors[i]!;
    const len = codepointCount(a.text);
    const pFrom = pCursor;
    const pTo = pCursor + len;
    let sourceQuote = "";
    for (let p = pFrom; p < pTo; p += 1) {
      const ch = pChars[p] ?? "";
      if (isPunc(ch)) continue;
      const sCh = sChars[sCursor] ?? "";
      if (sCh !== ch) {
        throw new Error(`source/punctuation mismatch at ${a.key}: ${sCh} vs ${ch}`);
      }
      sourceQuote += ch;
      sCursor += 1;
    }
    const sFrom = sCursor - codepointCount(sourceQuote);
    const sTo = sCursor;
    if (sliceCodepoints(punctuated, pFrom, pTo) !== a.text) {
      throw new Error(`punctuated quote mismatch ${a.key}`);
    }
    out.push({
      key: a.key,
      text: a.text,
      kind: a.kind,
      sent: a.sent,
      ordinal: i + 1,
      pFrom,
      pTo,
      sFrom,
      sTo,
      sourceQuote,
    });
    pCursor = pTo;
  }
  return out;
}

function insertTranslationVersion(
  db: SqliteDb,
  opts: {
    id: string;
    projectId: string;
    translationId: string;
    parentId: string | null;
    versionNo: number;
    sourceVersionId: string;
    puncVersionId: string;
    anchorSetId: string;
    policyVersionId: string;
    text: string;
    origin: string;
    messageId: string | null;
    candidateKey: string | null;
    validationState: "valid" | "needs_review";
    state: string;
    actorId: string;
    createdAt: string;
    blocks: BlockDraft[];
    anchors: AnchorRec[];
  },
): void {
  const translations = opts.blocks.map((b) => b.translation);
  const text = translations.length ? joinBlockTranslations(translations) : opts.text;
  insertRow(db, "document_translation_versions", {
    id: opts.id,
    project_id: opts.projectId,
    document_translation_id: opts.translationId,
    parent_version_id: opts.parentId,
    version_no: opts.versionNo,
    source_text_version_id: opts.sourceVersionId,
    punctuation_version_id: opts.puncVersionId,
    translation_anchor_set_id: opts.anchorSetId,
    translation_policy_version_id: opts.policyVersionId,
    text_content: text,
    origin_kind: opts.origin,
    workflow_execution_id: null,
    generated_by_message_id: opts.messageId,
    generation_candidate_key: opts.candidateKey,
    validation_state: opts.validationState,
    needs_review: opts.validationState === "needs_review" ? 1 : 0,
    state: opts.state,
    content_hash: sha256Hex(text),
    created_by_actor_id: opts.actorId,
    created_at: opts.createdAt,
  });
  const ranges = blockTargetRanges(translations);
  const byKey = new Map(opts.anchors.map((a) => [a.key, a]));
  for (let i = 0; i < opts.blocks.length; i += 1) {
    const b = opts.blocks[i]!;
    const range = ranges[i] ?? { from: 0, to: codepointCount(text) };
    const blockId = createId();
    insertRow(db, "translation_blocks", {
      id: blockId,
      project_id: opts.projectId,
      document_translation_version_id: opts.id,
      block_key: b.blockKey,
      ordinal: i + 1,
      block_kind: b.blockKind,
      target_codepoint_from: range.from,
      target_codepoint_to: range.to,
      target_hash: sha256Hex(sliceCodepoints(text, range.from, range.to)),
      validation_state: opts.validationState,
    });
    let ord = 1;
    for (const key of b.sourceAnchorIds) {
      const a = byKey.get(key);
      if (!a) continue;
      insertRow(db, "translation_block_anchors", {
        project_id: opts.projectId,
        translation_block_id: blockId,
        translation_anchor_id: a.id,
        ordinal: ord,
        relation_kind: "full",
        confidence: null,
      });
      ord += 1;
    }
  }
}

function seedGlossary(db: SqliteDb, projectId: string, actorId: string, createdAt: string): void {
  const rows: Array<{
    src: string;
    tgt: string;
    kind: string;
    read: string;
    st: "preferred" | "allowed" | "forbidden";
    note: string;
  }> = [
    {
      src: "中國",
      tgt: "중국(中國)",
      kind: "general",
      read: "중국",
      st: "preferred",
      note: "序文의 中國은 명(明)을 가리킴. 지명 표에도 등록.",
    },
    {
      src: "文字",
      tgt: "문자(文字)",
      kind: "general",
      read: "문자",
      st: "preferred",
      note: "문맥상 한자(漢字)를 뜻한다는 해석이 우세. U-01 참조.",
    },
    {
      src: "文字",
      tgt: "한자(漢字)",
      kind: "general",
      read: "한자",
      st: "allowed",
      note: "독자안에서 사용 가능. 원문 밖 해석이므로 병기 필수.",
    },
    {
      src: "愚民",
      tgt: "어리석은 백성",
      kind: "general",
      read: "우민",
      st: "allowed",
      note: "‘글을 모르는 백성’ 해석도 열려 있음. U-02 참조.",
    },
    {
      src: "愚民",
      tgt: "우민(愚民)",
      kind: "general",
      read: "우민",
      st: "forbidden",
      note: "음차만으로는 뜻이 전달되지 않음.",
    },
    {
      src: "二十八字",
      tgt: "스물여덟 자",
      kind: "technical",
      read: "이십팔자",
      st: "preferred",
      note: "초성 17자 + 중성 11자.",
    },
    { src: "正音", tgt: "정음(正音)", kind: "technical", read: "정음", st: "preferred", note: "" },
    {
      src: "初聲",
      tgt: "초성(初聲)",
      kind: "technical",
      read: "초성",
      st: "preferred",
      note: "中聲·終聲과 같은 방식으로 병기.",
    },
    {
      src: "諺文",
      tgt: "언문(諺文)",
      kind: "technical",
      read: "언문",
      st: "preferred",
      note: "실록 기사에서 훈민정음을 가리키는 표현. 풀어 쓰지 않음.",
    },
    { src: "集賢殿", tgt: "집현전(集賢殿)", kind: "institution", read: "집현전", st: "preferred", note: "" },
    { src: "承政院", tgt: "승정원(承政院)", kind: "institution", read: "승정원", st: "preferred", note: "" },
    {
      src: "殿下",
      tgt: "전하(殿下)",
      kind: "general",
      read: "전하",
      st: "preferred",
      note: "鄭麟趾 序에서 世宗을 지칭.",
    },
  ];
  for (const r of rows) {
    insertRow(db, "glossary_entries", {
      id: createId(),
      project_id: projectId,
      source_term: r.src,
      target_locale: "ko",
      target_term: r.tgt,
      term_kind: r.kind,
      reading: r.read,
      note_md: r.note || null,
      usage_status: r.st,
      content_hash: sha256Hex(`${r.src}|${r.tgt}|${r.st}`),
      lock_version: 1,
      created_by_actor_id: actorId,
      updated_by_actor_id: actorId,
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: null,
    });
  }
}

function seedUncertainties(
  db: SqliteDb,
  projectId: string,
  actorId: string,
  anchors: AnchorRec[],
  eojeseoNodeId: string,
  jeongNodeId: string,
  createdAt: string,
): void {
  const a002 = anchors.find((a) => a.key === "A002");
  const a003 = anchors.find((a) => a.key === "A003");
  const items: Array<{
    label: string;
    cat: "textual" | "interpretive" | "identification";
    sev: string;
    state: string;
    stmt: string;
    locator: string;
    quote: string;
    opts: string[];
    rationale: string;
    anchorId?: string;
    nodeId: string;
  }> = [
    {
      label: "U-01",
      cat: "interpretive",
      sev: "major",
      state: "open",
      stmt: "U-01 文字의 지시 대상 — 한자인가, 문자 일반인가",
      locator: "御製序 · A002",
      quote: "與文字不相流通",
      opts: ["한자 — 명의 문자와 통하지 않는다는 뜻 (우세)", "문자 일반 — 말과 글이 서로 통하지 않는다는 뜻"],
      rationale: "후행 문장의 ‘新制二十八字’와 대비되는 기존 문자 체계를 가리키므로 한자로 읽는 해석이 자연스럽다.",
      anchorId: a002?.id,
      nodeId: eojeseoNodeId,
    },
    {
      label: "U-02",
      cat: "interpretive",
      sev: "minor",
      state: "open",
      stmt: "U-02 愚民의 愚 — ‘어리석은’ / ‘글을 모르는’",
      locator: "御製序 · A003",
      quote: "故愚民有所欲言",
      opts: ["어리석은 백성", "글을 모르는 백성"],
      rationale: "독자안은 ‘글을 모르는’으로 의역했고 Reflection이 이를 원문 밖 해석으로 표시했다.",
      anchorId: a003?.id,
      nodeId: eojeseoNodeId,
    },
    {
      label: "U-03",
      cat: "identification",
      sev: "minor",
      state: "open",
      stmt: "U-03 서문 말미 학사들의 관직 대응어",
      locator: "鄭麟趾 序",
      quote: "集賢殿應敎 …",
      opts: ["관직명 음차 + 漢字 병기", "직능 설명을 괄호로 보충"],
      rationale: "용어집 term_kind = office 항목을 먼저 확정해야 한다.",
      nodeId: jeongNodeId,
    },
  ];
  for (const u of items) {
    const uid = createId();
    const vid = createId();
    insertRow(db, "uncertainties", {
      id: uid,
      project_id: projectId,
      category: u.cat,
      severity: u.sev,
      blocking: 0,
      state: u.state,
      created_at: createdAt,
    });
    insertRow(db, "uncertainty_versions", {
      id: vid,
      project_id: projectId,
      uncertainty_id: uid,
      parent_version_id: null,
      version_no: 1,
      statement_md: u.stmt,
      rationale_md: u.rationale,
      confidence_label: null,
      content_hash: sha256Hex(u.stmt),
      created_by_actor_id: actorId,
      created_at: createdAt,
    });
    u.opts.forEach((label, i) => {
      insertRow(db, "uncertainty_options", {
        id: createId(),
        project_id: projectId,
        uncertainty_version_id: vid,
        label,
        interpretation_md: null,
        ordinal: i + 1,
      });
    });
    insertRow(db, "uncertainty_anchors", {
      id: createId(),
      project_id: projectId,
      uncertainty_version_id: vid,
      target_kind: u.anchorId ? "translation_anchor" : "document_node",
      target_version_id: u.anchorId ?? u.nodeId,
      codepoint_from: null,
      codepoint_to: null,
      quote: u.quote,
      quote_hash: sha256Hex(u.quote),
    });
  }
}
