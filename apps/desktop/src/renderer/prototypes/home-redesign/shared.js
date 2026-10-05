// Home redesign studies: example data and the real app chrome around each study.
// Mock data only. No app API, database, network, or persistence.

export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const STAGES = [
  { key: 'source', label: '원문', mark: '原' },
  { key: 'punctuation', label: '표점', mark: '點' },
  { key: 'translation', label: '번역안', mark: '譯' },
  { key: 'review', label: '재검토', mark: '覆' },
  { key: 'confirmed', label: '확정', mark: '定' },
];
export const stageLabel = key => STAGES.find(stage => stage.key === key)?.label ?? '원문';

/** Fixed "now" so relative times read the same on every load (Monday). */
export const NOW = new Date(2026, 8, 28, 15, 40);
const sep = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute);

const BOOKS = [
  { id: 'b1', key: '學而', ko: '학이', numeral: '一', openings: ['學而時習之', '其爲人也孝弟', '巧言令色', '吾日三省吾身', '道千乘之國', '弟子入則孝', '賢賢易色', '君子不重則不威', '愼終追遠', '夫子至於是邦也', '父在觀其志', '禮之用和爲貴', '信近於義', '君子食無求飽', '貧而無諂', '不患人之不己知'] },
  { id: 'b2', key: '爲政', ko: '위정', numeral: '二', openings: ['爲政以德', '詩三百', '道之以政', '吾十有五而志于學', '孟懿子問孝', '孟武伯問孝', '子游問孝', '子夏問孝', '吾與回言終日', '視其所以', '溫故而知新', '君子不器', '子貢問君子', '君子周而不比', '學而不思則罔', '攻乎異端', '誨女知之乎', '子張學干祿', '何爲則民服', '使民敬忠以勸', '子奚不爲政', '人而無信', '十世可知也', '非其鬼而祭之'] },
  { id: 'b3', key: '八佾', ko: '팔일', numeral: '三', openings: ['八佾舞於庭', '三家者以雍徹', '人而不仁如禮何', '林放問禮之本', '夷狄之有君', '季氏旅於泰山', '君子無所爭', '巧笑倩兮', '夏禮吾能言之', '禘自旣灌而往者', '或問禘之說', '祭如在', '與其媚於奧', '周監於二代', '子入大廟', '射不主皮', '告朔之餼羊', '事君盡禮', '君使臣臣事君', '關雎樂而不淫', '哀公問社於宰我', '管仲之器小哉', '子語魯大師樂', '儀封人請見', '子謂韶', '居上不寬'] },
  { id: 'b4', key: '里仁', ko: '이인', numeral: '四', openings: ['里仁爲美', '不仁者不可以久處約', '唯仁者能好人', '苟志於仁矣', '富與貴', '我未見好仁者', '人之過也', '朝聞道', '士志於道', '君子之於天下也', '君子懷德', '放於利而行', '能以禮讓爲國乎', '不患無位', '吾道一以貫之', '君子喩於義', '見賢思齊焉', '事父母幾諫', '父母在不遠遊', '三年無改於父之道', '父母之年', '古者言之不出', '以約失之者', '君子欲訥於言', '德不孤', '事君數'] },
  { id: 'b5', key: '公冶長', ko: '공야장', numeral: '五', openings: [] },
];

// One letter per chapter: C confirmed, R review, T translation draft, P punctuation confirmed, p punctuation draft, S source only.
const PLAN = {
  medium: { 學而: 'CRCCCCCRCCCCTCCC', 爲政: 'CCTTTTPPpPPpSSSSSSSSSSSS' },
  large: { 學而: 'CRCCCCCRCCCCTCCC', 爲政: 'CCTTTTPPpPPpSSSSSSSSSSSS', 八佾: 'PPpPppSSSSSSSSSSSSSSSSSSSS', 里仁: 'pSSSSSSSSSSSSSSSSSSSSSSSSS', 公冶長: '' },
  small: { 學而: 'CRT' },
  empty: {},
};
const LETTER = {
  C: { stage: 'confirmed', punctuation: 'confirmed', translation: 'confirmed' },
  R: { stage: 'review', punctuation: 'confirmed', translation: 'review' },
  T: { stage: 'translation', punctuation: 'confirmed', translation: 'draft' },
  P: { stage: 'punctuation', punctuation: 'confirmed', translation: 'none' },
  p: { stage: 'punctuation', punctuation: 'draft', translation: 'none' },
  S: { stage: 'source', punctuation: 'none', translation: 'none' },
};

const PUNCTUATED = {
  '學而 1': '子曰：「學而時習之，不亦說乎？有朋自遠方來，不亦樂乎？人不知而不慍，不亦君子乎？」',
  '學而 2': '有子曰：「其爲人也孝弟，而好犯上者，鮮矣；不好犯上，而好作亂者，未之有也。君子務本，本立而道生。孝弟也者，其爲仁之本與！」',
  '學而 3': '子曰：「巧言令色，鮮矣仁！」',
  '學而 4': '曾子曰：「吾日三省吾身：爲人謀而不忠乎？與朋友交而不信乎？傳不習乎？」',
  '學而 8': '子曰：「君子不重則不威，學則不固。主忠信，無友不如己者，過則勿憚改。」',
  '爲政 1': '子曰：「爲政以德，譬如北辰，居其所而衆星共之。」',
  '爲政 2': '子曰：「詩三百，一言以蔽之，曰：『思無邪』。」',
  '爲政 3': '子曰：「道之以政，齊之以刑，民免而無恥；道之以德，齊之以禮，有恥且格。」',
  '爲政 4': '子曰：「吾十有五而志于學，三十而立，四十而不惑，五十而知天命，六十而耳順，七十而從心所欲，不踰矩。」',
  '爲政 11': '子曰：「溫故而知新，可以爲師矣。」',
  '爲政 15': '子曰：「學而不思則罔，思而不學則殆。」',
  '爲政 16': '子曰：「攻乎異端，斯害也已！」',
  '里仁 8': '子曰：「朝聞道，夕死可矣。」',
};
const TRANSLATION = {
  '學而 1': '공자께서 말씀하셨다. “배우고 때때로 익히면 또한 기쁘지 아니한가. 벗이 먼 곳에서 찾아오면 또한 즐겁지 아니한가. 남이 알아주지 않아도 서운해하지 않으면 또한 군자답지 아니한가.”',
  '學而 2': '유자가 말하였다. “그 사람됨이 효성스럽고 공손하면서 윗사람 범하기를 좋아하는 이는 드물다. 윗사람 범하기를 좋아하지 않으면서 난을 일으키기 좋아하는 이는 없었다. 군자는 근본에 힘쓰니, 근본이 서면 도가 생겨난다. 효성과 공손은 인을 행하는 근본일 것이다.”',
  '學而 3': '공자께서 말씀하셨다. “말을 교묘하게 하고 낯빛을 꾸미는 이 가운데 어진 이는 드물다.”',
  '學而 4': '증자가 말하였다. “나는 날마다 세 가지로 나 자신을 살핀다. 남을 위해 일을 꾀하면서 정성을 다하지 않았는가? 벗과 사귀면서 미덥지 않았는가? 전해 받은 것을 익히지 않았는가?”',
  '學而 8': '공자께서 말씀하셨다. “군자가 무게가 없으면 위엄이 없고, 배워도 견고하지 못하다. 충실과 미더움을 위주로 하고, 자기만 못한 이를 벗하지 말며, 허물이 있으면 고치기를 꺼리지 말라.”',
  '爲政 1': '공자께서 말씀하셨다. “덕으로 정치를 하는 것은 비유하자면 북극성이 제자리에 있고 뭇별이 그를 향해 도는 것과 같다.”',
  '爲政 2': '공자께서 말씀하셨다. “『시경』 삼백 편을 한마디로 덮어 말하면 ‘생각에 삿됨이 없다’는 것이다.”',
  '爲政 3': '공자께서 말씀하셨다. “정령으로 이끌고 형벌로 가지런히 하면 백성이 형벌은 면하려 하나 부끄러움이 없다. 덕으로 이끌고 예로 가지런히 하면 부끄러움을 알고 또 바르게 된다.”',
  '爲政 4': '공자께서 말씀하셨다. “나는 열다섯에 배움에 뜻을 두었고, 서른에 섰으며, 마흔에 미혹되지 않았고, 쉰에 천명을 알았으며, 예순에 귀가 순해졌고, 일흔에 마음이 하고자 하는 대로 따라도 법도를 넘지 않았다.”',
};
const rawSource = text => text?.replace(/[：「」『』，。？！；\s]/g, '') ?? null;

const UNCERTAINTIES = [
  { id: 'u5', doc: '學而 1', title: '「不亦說乎」의 說을 ‘열(悅)’로 읽음', note: '집주의 음주(音注)를 따라 ‘기쁘다’로 옮기고 독음은 주석에 밝힌다.', state: 'resolved', at: sep(19, 16, 20) },
  { id: 'u1', doc: '學而 2', title: '「孝弟」의 弟 — ‘공손’으로 옮길지', note: '悌와 통용되는 글자. 본문은 ‘공손’으로 두고 통용 관계를 주석으로 밝힐지 검토.', state: 'open', at: sep(25, 11, 0) },
  { id: 'u2', doc: '學而 8', title: '「無友不如己者」 — 벗의 조건인가, 사귀는 태도인가', note: '‘자기만 못한 이를 벗하지 말라’와 ‘벗 사귐에 자기만 못한 이가 없게 하라’ 사이.', state: 'open', at: sep(27, 22, 10) },
  { id: 'u3', doc: '爲政 4', title: '「耳順」 — 직역과 풀이 사이', note: '‘귀가 순해졌다’로 두고 풀이를 주석에 둘지, 본문에서 풀어 옮길지.', state: 'open', at: sep(28, 14, 5) },
  { id: 'u4', doc: '爲政 16', title: '「攻乎異端」의 攻 — ‘전공하다’와 ‘공격하다’', note: '집주는 ‘전치(專治)’. 고주와 다른 해석을 함께 제시할지 결정 필요.', state: 'open', at: sep(27, 16, 5) },
  { id: 'u6', doc: '八佾 8', title: '「繪事後素」 — 바탕이 먼저인가, 흰색이 나중인가', note: '주자와 정현의 해석이 갈린다. 다음 장 ‘禮後乎’와 함께 읽을 것.', state: 'open', at: sep(23, 20, 40) },
];

// Recent history for the medium and large projects. Older history is generated per document.
const EVENTS = [
  { doc: '爲政 4', at: sep(28, 14, 32), kind: 'translation', text: '번역안 v3 저장', diff: ['예순에 귀로 듣는 것이 순조로웠고', '예순에 귀가 순해졌고'] },
  { doc: '爲政 4', at: sep(28, 14, 5), kind: 'uncertainty', text: '불확실성 기록 · 「耳順」 — 직역과 풀이 사이' },
  { doc: '爲政 4', at: sep(28, 13, 48), kind: 'ai', text: 'AI 번역 제안 받음 · v2 기준' },
  { doc: '爲政 3', at: sep(28, 11, 20), kind: 'translation', text: '번역안 v2 저장' },
  { doc: '爲政 12', at: sep(28, 10, 2), kind: 'punctuation', text: '표점 초안 저장' },
  { doc: '學而 8', at: sep(27, 22, 10), kind: 'review', text: '재검토로 되돌림 · 「無友不如己者」' },
  { doc: '爲政 2', at: sep(27, 21, 40), kind: 'confirm', text: '번역 확정 · v4' },
  { doc: '爲政 1', at: sep(27, 20, 15), kind: 'confirm', text: '번역 확정 · v5' },
  { doc: '爲政 11', at: sep(27, 17, 30), kind: 'punctuation', text: '표점 확정' },
  { doc: '爲政 16', at: sep(27, 16, 5), kind: 'uncertainty', text: '불확실성 기록 · 「攻乎異端」의 攻' },
  { doc: '爲政 6', at: sep(26, 19, 50), kind: 'translation', text: '번역안 v1 저장' },
  { doc: '爲政 5', at: sep(26, 18, 25), kind: 'translation', text: '번역안 v2 저장' },
  { doc: '爲政 9', at: sep(26, 15, 10), kind: 'punctuation', text: '표점 초안 저장' },
  { doc: '學而 16', at: sep(25, 19, 13), kind: 'confirm', text: '번역 확정 · v3' },
  { doc: '學而 15', at: sep(25, 18, 40), kind: 'confirm', text: '번역 확정 · v4' },
  { doc: '學而 13', at: sep(25, 15, 20), kind: 'translation', text: '번역안 v2 저장' },
  { doc: '學而 2', at: sep(25, 11, 0), kind: 'review', text: '재검토로 되돌림 · 「孝弟」' },
  { doc: '學而 2', at: sep(24, 21, 30), kind: 'comment', text: '코멘트 · “弟를 ‘공경’으로 옮긴 예도 확인해 볼 것”' },
  { doc: '八佾 8', at: sep(23, 20, 40), kind: 'uncertainty', text: '불확실성 기록 · 「繪事後素」' },
];
const SMALL_EVENTS = [
  { doc: '學而 3', at: sep(28, 11, 5), kind: 'translation', text: '번역안 v1 저장' },
  { doc: '學而 3', at: sep(28, 10, 40), kind: 'ai', text: 'AI 번역 제안 받음' },
  { doc: '學而 2', at: sep(27, 21, 30), kind: 'review', text: '재검토로 되돌림 · 「孝弟」' },
  { doc: '學而 2', at: sep(27, 20, 0), kind: 'translation', text: '번역안 v2 저장' },
  { doc: '學而 1', at: sep(26, 20, 10), kind: 'confirm', text: '번역 확정 · v2' },
  { doc: '學而 1', at: sep(26, 18, 0), kind: 'punctuation', text: '표점 확정' },
];

const CONTEXT = [
  { title: '번역 기준', body: '주자 『論語集註』의 해석을 따른다. 고주(何晏 『論語集解』)와 갈리는 곳은 불확실성 기록에 근거를 남긴다.' },
  { title: '호칭', body: '子는 ‘공자께서’로 옮긴다. 제자는 ‘유자’, ‘증자’처럼 부르고 처음 나올 때 이름을 밝힌다.' },
  { title: '문체', body: '평서체 ‘~하셨다 / ~하였다’를 쓴다. 인용문은 큰따옴표로 묶는다.' },
];

function lastAction(letter, version) {
  return {
    C: { kind: 'confirm', text: `번역 확정 · v${version}` },
    R: { kind: 'review', text: '재검토로 되돌림' },
    T: { kind: 'translation', text: `번역안 v${version} 저장` },
    P: { kind: 'punctuation', text: '표점 확정' },
    p: { kind: 'punctuation', text: '표점 초안 저장' },
    S: { kind: 'add', text: '원문 추가' },
  }[letter];
}
/** When the chapter's source text was imported; every document gets one "원문 추가" event at this time. */
function importTime(book, scenario) {
  if (scenario === 'small') return sep(26, 17, 30);
  return book === '八佾' || book === '里仁' ? sep(20, 9, 30) : sep(8, 10, 0);
}
function fallbackTime(book, no, letter, scenario) {
  if (letter === 'S') return importTime(book, scenario);
  if (book === '學而') return sep(10 + Math.ceil(no * 14 / 16), 9 + (no * 5) % 12, (no * 13) % 60);
  if (book === '八佾') return sep(21 + (no % 3), 14 + no, (no * 7) % 60);
  if (book === '里仁') return sep(22, 16, 30);
  return sep(26, 10 + (no % 6), (no * 11) % 60);
}

export function getDemo() {
  const allowed = ['empty', 'small', 'medium', 'large'];
  const query = new URLSearchParams(location.search).get('scenario');
  const scenario = allowed.includes(query) ? query : 'medium';
  const plan = PLAN[scenario];
  const docs = [];
  const groups = [];

  if (scenario === 'large') {
    docs.push({
      id: 'preface', key: '論語序說', book: null, no: 0, groupId: null, title: '論語序說', opening: '論語序說', ko: '논어서설',
      stage: 'confirmed', punctuation: 'confirmed', translation: 'confirmed', version: 3, letter: 'C',
      source: null, punctuated: null, translationText: null, comments: 0, terms: 6, updatedAt: sep(9, 17, 0),
    });
  }
  for (const book of BOOKS) {
    const letters = plan[book.key];
    if (letters === undefined) continue;
    const group = { id: book.id, key: book.key, ko: book.ko, title: `${book.key} 第${book.numeral}`, docs: [] };
    [...letters].forEach((letter, index) => {
      const no = index + 1;
      const key = `${book.key} ${no}`;
      const state = LETTER[letter];
      const version = letter === 'S' || letter === 'P' || letter === 'p' ? 0 : (no % 4) + 2;
      const doc = {
        id: `${book.id}-${no}`, key, book: book.key, no, groupId: book.id,
        title: key, opening: book.openings[index], ko: `${book.ko} ${no}장`,
        ...state, version, letter,
        punctuated: state.punctuation !== 'none' ? PUNCTUATED[key] ?? null : null,
        source: rawSource(PUNCTUATED[key]),
        translationText: state.translation !== 'none' ? TRANSLATION[key] ?? null : null,
        comments: { '學而 2': 2, '學而 8': 1, '爲政 4': 1 }[key] ?? 0,
        terms: state.punctuation === 'confirmed' ? (no % 4) + 1 : 0,
        updatedAt: fallbackTime(book.key, no, letter, scenario),
      };
      if (scenario === 'small') doc.version = { C: 2, R: 2, T: 1 }[letter];
      group.docs.push(doc);
      docs.push(doc);
    });
    groups.push(group);
  }

  const byKey = new Map(docs.map(doc => [doc.key, doc]));
  const handcrafted = (scenario === 'small' ? SMALL_EVENTS : EVENTS).filter(event => byKey.has(event.doc));
  const events = handcrafted.map(event => ({ ...event, docId: byKey.get(event.doc).id }));
  for (const doc of docs) {
    const own = events.filter(event => event.docId === doc.id);
    if (own.length) {
      doc.updatedAt = new Date(Math.max(...own.map(event => +event.at)));
      // Keep the version in step with the latest recorded "v3"-style event.
      const versioned = own.filter(event => /\bv(\d+)/.test(event.text)).sort((a, b) => b.at - a.at)[0];
      if (versioned) doc.version = Number(versioned.text.match(/\bv(\d+)/)[1]);
    } else if (doc.letter !== 'S') {
      events.push({ doc: doc.key, docId: doc.id, at: doc.updatedAt, ...lastAction(doc.letter, doc.version) });
    }
    events.push({ doc: doc.key, docId: doc.id, at: importTime(doc.book, scenario), ...lastAction('S', 0) });
  }
  events.sort((a, b) => b.at - a.at);

  const uncertainties = UNCERTAINTIES.filter(item => byKey.has(item.doc)).map(item => ({ ...item, docId: byKey.get(item.doc).id }));
  for (const doc of docs) doc.uncertainties = uncertainties.filter(item => item.docId === doc.id && item.state === 'open').length;

  const ordered = [...docs].sort((a, b) => b.updatedAt - a.updatedAt);
  const resume = ordered.find(doc => doc.stage !== 'confirmed') ?? ordered[0] ?? null;
  const count = key => docs.filter(doc => doc.stage === key).length;
  const stats = {
    total: docs.length,
    ...Object.fromEntries(STAGES.map(stage => [stage.key, count(stage.key)])),
    openUncertainties: uncertainties.filter(item => item.state === 'open').length,
  };

  const project = scenario === 'empty'
    ? { title: '새 프로젝트', subtitle: '', description: '', base: '', scope: '', file: '~/Documents/문해/새 프로젝트.munhae' }
    : {
      title: '論語 譯註', subtitle: '논어 역주',
      description: '주자의 『논어집주』를 저본으로 본문을 표점하고 번역한다. 해석이 갈리는 곳은 고주와 대조해 근거를 남긴다.',
      base: '『論語集註』(朱熹)', scope: scenario === 'large' ? '序說 · 學而 ~ 公冶長' : scenario === 'small' ? '學而' : '學而 · 爲政',
      file: '~/Documents/문해/論語 譯註.munhae',
    };

  return { scenario, now: NOW, project, groups, docs, events, uncertainties, context: scenario === 'empty' ? [] : CONTEXT, resume, stats };
}

export function stageTag(doc) {
  return `<span class="tag st-tag st-${esc(doc.stage)}">${esc(stageLabel(doc.stage))}</span>`;
}

const pad = n => String(n).padStart(2, '0');
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export const fmtTime = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
/** "14:32", "어제 21:40", "3일 전", "9월 8일" relative to NOW. */
export function fmtWhen(date) {
  if (sameDay(date, NOW)) return fmtTime(date);
  const yesterday = new Date(NOW); yesterday.setDate(NOW.getDate() - 1);
  if (sameDay(date, yesterday)) return `어제 ${fmtTime(date)}`;
  const days = Math.round((new Date(NOW).setHours(0, 0, 0, 0) - new Date(date).setHours(0, 0, 0, 0)) / 86400000);
  return days < 7 ? `${days}일 전` : `${date.getMonth() + 1}월 ${date.getDate()}일`;
}
/** "오늘 · 9월 28일 월요일" style day heading. */
export function fmtDay(date) {
  const base = `${date.getMonth() + 1}월 ${date.getDate()}일 ${WEEKDAYS[date.getDay()]}요일`;
  if (sameDay(date, NOW)) return `오늘 · ${base}`;
  const yesterday = new Date(NOW); yesterday.setDate(NOW.getDate() - 1);
  return sameDay(date, yesterday) ? `어제 · ${base}` : base;
}

const ICON = {
  folderOpen: '<path d="m4 9.33 1-1.93a1.33 1.33 0 0 1 1.16-.73h7.17a1.33 1.33 0 0 1 1.29 1.67l-1.03 4a1.33 1.33 0 0 1-1.3 1H2.67a1.33 1.33 0 0 1-1.34-1.34V3.33A1.33 1.33 0 0 1 2.67 2h2.6a1.33 1.33 0 0 1 1.12.6l.54.8a1.33 1.33 0 0 0 1.12.6H12a1.33 1.33 0 0 1 1.33 1.33v1.34"/>',
  folder: '<path d="M13.33 13.33a1.33 1.33 0 0 0 1.33-1.33V5.33a1.33 1.33 0 0 0-1.33-1.33h-5.27a1.33 1.33 0 0 1-1.13-.6L6.4 2.6A1.33 1.33 0 0 0 5.29 2H2.67a1.33 1.33 0 0 0-1.33 1.33v8.67a1.33 1.33 0 0 0 1.33 1.33Z"/>',
  doc: '<path d="M4 14.67a1.33 1.33 0 0 1-1.33-1.33V2.67a1.33 1.33 0 0 1 1.33-1.33h5.33a1.6 1.6 0 0 1 1.14 .47l2.39 2.39A1.6 1.6 0 0 1 13.33 5.33v8a1.33 1.33 0 0 1-1.33 1.33z"/><path d="M9.33 1.33v3.33a.67 .67 0 0 0 .67 .67h3.33"/><path d="M6.67 6H5.33"/><path d="M10.67 8.67H5.33"/><path d="M10.67 11.33H5.33"/>',
  context: '<path d="m10.67 4 2.67 9.33"/><path d="M8 4v9.33"/><path d="M5.33 5.33v8"/><path d="M2.67 2.67v10.67"/>',
  glossary: '<path d="M8 3.33v10.67"/><path d="M13.33 12.67A1.33 1.33 0 0 0 14.67 11.33V3.33a1.33 1.33 0 0 0-1.33-1.33L10.67 2A3.33 3.33 0 0 0 8 3.33a3.33 3.33 0 0 0-2.67-1.33H2.67a1.33 1.33 0 0 0-1.33 1.33v8a1.33 1.33 0 0 0 1.33 1.33H5.33a3.33 3.33 0 0 1 2.67 1.33 3.33 3.33 0 0 1 2.67-1.33z"/>',
  comments: '<path d="M14.67 11.33a1.33 1.33 0 0 1-1.33 1.33H4.55a1.33 1.33 0 0 0-.94 .39l-1.47 1.47A.47 .47 0 0 1 1.33 14.19V3.33a1.33 1.33 0 0 1 1.33-1.33h10.67a1.33 1.33 0 0 1 1.33 1.33z"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2.2v1.2M8 12.6v1.2M2.2 8h1.2M12.6 8h1.2M3.9 3.9l.9.9M11.2 11.2l.9.9M12.1 3.9l-.9.9M4.8 11.2l-.9.9"/>',
  community: '<path d="M10.67 14v-1.33a2.67 2.67 0 0 0-2.67-2.67H4a2.67 2.67 0 0 0-2.67 2.67v1.33"/><path d="M10.67 2.09a2.67 2.67 0 0 1 0 5.16"/><path d="M14.67 14v-1.33a2.67 2.67 0 0 0-2-2.58"/><circle cx="6" cy="4.67" r="2.67"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  sidebar: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10"/>',
  back: '<path d="M13 8H3m5-5L3 8l5 5"/>',
  forward: '<path d="M3 8h10m-5-5 5 5-5 5"/>',
};
export const icon = (name, className = 'ic') => `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

const sidebarDot = doc => ({
  confirmed: '<i class="dot ok" role="img" aria-label="번역: 확정"></i>',
  review: '<i class="dot warn" role="img" aria-label="번역: 재검토"></i>',
  translation: '<i class="dot draft" role="img" aria-label="번역: 번역안"></i>',
}[doc.stage] ?? '');

function sidebarTree(demo, expanded) {
  const item = (depth, body, attrs = '', extra = '') => `<div class="sb-row${extra}" role="none"><button class="sb-item" type="button" role="treeitem" data-depth="${depth}" style="--sb-depth:${depth}" ${attrs}>${body}</button></div>`;
  const docRow = (doc, depth) => item(depth, `${icon('doc')}<span class="lbl hanmun">${esc(doc.title)}</span>${sidebarDot(doc)}`, `data-open-doc="${esc(doc.id)}" title="${esc(doc.title)} · ${esc(doc.opening)}"`);
  const rows = [];
  rows.push(`<div class="sb-row" role="none"><button class="sb-item is-current" type="button" role="treeitem" data-depth="0" style="--sb-depth:0" aria-expanded="true" aria-current="page" data-home-top>${icon('chevron', 'ic chev')}${icon('folderOpen')}<span class="lbl hanmun">${esc(demo.project.title)}</span><span class="cnt">${demo.stats.total}</span></button></div>`);
  const children = [];
  children.push(item(1, `${icon('context')}<span class="lbl">문맥</span>`, 'data-proto-note="공통 문맥"', ' sb-context'));
  for (const doc of demo.docs.filter(d => !d.groupId)) children.push(docRow(doc, 1));
  for (const group of demo.groups) {
    const open = expanded.has(group.id);
    children.push(`<div class="sb-row" role="none"><button class="sb-item" type="button" role="treeitem" data-depth="1" style="--sb-depth:1" aria-expanded="${open}" data-toggle-group="${esc(group.id)}" title="${esc(group.title)} · 목차 폴더">${icon('chevron', 'ic chev')}${icon(open ? 'folderOpen' : 'folder')}<span class="lbl hanmun">${esc(group.title)}</span>${group.docs.length ? `<span class="cnt">${group.docs.length}</span>` : ''}</button></div>`);
    if (open) children.push(`<div class="sb-children" style="--sb-depth:1" role="none">${group.docs.map(doc => docRow(doc, 2)).join('')}</div>`);
  }
  rows.push(`<div class="sb-children" style="--sb-depth:0" role="none">${children.join('')}</div>`);
  return rows.join('');
}

/**
 * Wraps a study in the real Munhae window chrome (tokens.css + chrome.css).
 * Returns the `.content` element; the study owns everything inside it.
 * Options: design ("01 작업 대장"), status (statusbar text, optional), hideSidebar (bool).
 */
export function mountShell({ design, status, hideSidebar = false }) {
  const demo = getDemo();
  document.documentElement.dataset.platform = 'mac';
  const expanded = new Set(demo.resume?.groupId ? [demo.resume.groupId] : []);
  document.body.innerHTML = `
<div class="win unified-titlebar${hideSidebar ? ' sb-hidden' : ''}" id="win" style="--sbw:224px">
  <header class="titlebar">
    <div class="titlebar-navigation" role="group" aria-label="화면 탐색"><span class="titlebar-window-space" aria-hidden="true"><i></i><i></i><i></i></span><button class="tb${hideSidebar ? '' : ' is-on'}" id="tbSidebar" type="button" aria-label="사이드바 토글" title="사이드바">${icon('sidebar')}</button><button class="tb" type="button" aria-label="뒤로" disabled>${icon('back')}</button><button class="tb" type="button" aria-label="앞으로" disabled>${icon('forward')}</button></div>
    <div class="tb-c"><span class="proxy" aria-hidden="true"></span><span class="hanmun">${esc(demo.project.title)}</span><small>— 프로젝트 홈</small></div>
    <div class="tb-r"><a class="proto-flag" href="./index.html?view=${esc(design.split(' ')[0])}&amp;scenario=${demo.scenario}" target="_top" title="시안 비교로 돌아가기">시안 ${esc(design)} · 예시 데이터</a><button class="tb" type="button" data-proto-note="백업">백업</button><button class="tb" type="button" data-proto-note="내보내기">내보내기</button></div>
  </header>
  <aside class="sidebar" id="sidebar" aria-label="탐색">
    <div class="munhae-brand" role="img" aria-label="문해 Munhae Studio"><strong aria-hidden="true">文解</strong><small aria-hidden="true">MUNHAE<br>STUDIO</small></div>
    <div class="sb-project-actions"><button type="button" class="sb-app-trigger sb-project-switch" data-proto-note="프로젝트 전환"><span class="sb-project-name">${esc(demo.project.title)}</span><span aria-hidden="true">⌄</span></button><button type="button" class="sb-app-trigger" data-proto-note="프로젝트 관리" aria-label="프로젝트 관리">⋯</button></div>
    <div class="sb-search">${icon('search')}<input type="search" placeholder="문서 찾기" aria-label="문서 찾기"><kbd aria-hidden="true">⌘P</kbd></div>
    <div class="sb-scroll" id="sbTree">
      <div class="sb-h-row"><div class="sb-h">문서</div><button class="sb-app-trigger sb-add-document" type="button" data-proto-note="문서 추가" aria-label="문서 추가">+</button></div>
      <div id="sbDocuments" role="tree" aria-label="문서"></div>
      <div class="sb-row sb-library"><button class="sb-item" type="button" data-depth="0" style="--sb-depth:0" data-proto-note="문맥">${icon('context')}<span class="lbl">문맥</span></button></div>
      <div class="sb-row sb-library"><button class="sb-item" type="button" data-depth="0" style="--sb-depth:0" data-proto-note="용어">${icon('glossary')}<span class="lbl">용어</span></button></div>
      <div class="sb-row sb-library"><button class="sb-item" type="button" data-depth="0" style="--sb-depth:0" data-proto-note="코멘트">${icon('comments')}<span class="lbl">코멘트</span></button></div>
    </div>
    <div class="sb-foot"><div class="sb-footer-nav"><div class="sb-row"><button class="sb-item" type="button" data-depth="0" style="--sb-depth:0" data-proto-note="설정">${icon('settings')}<span class="lbl">설정</span></button></div><div class="sb-row"><button class="sb-item" type="button" data-depth="0" style="--sb-depth:0" data-proto-note="커뮤니티">${icon('community')}<span class="lbl">커뮤니티</span></button></div></div></div>
  </aside>
  <div class="main"><div class="content proto-content" id="protoContent"></div></div>
  <footer class="statusbar">
    <span class="mono">${esc(demo.project.file)}</span><span>로컬 프로젝트</span><span class="sp"></span>
    <span>${esc(status ?? "")}</span>
    <span>저장됨 <b>${demo.events[0] ? fmtTime(demo.events[0].at) : '—'}</b></span><span><i class="dot ok"></i>Claude</span><button type="button" data-proto-note="명령 검색">⌘K</button>
  </footer>
</div>
<div class="notif" id="notif" role="status" aria-live="polite"><div class="ai" aria-hidden="true">文</div><div><b id="nTitle">문해</b><span id="nMsg"></span></div></div>`;

  const tree = document.getElementById('sbDocuments');
  const renderTree = () => { tree.innerHTML = sidebarTree(demo, expanded); };
  renderTree();
  document.getElementById('tbSidebar').addEventListener('click', event => {
    const win = document.getElementById('win');
    win.classList.toggle('sb-hidden');
    event.currentTarget.classList.toggle('is-on', !win.classList.contains('sb-hidden'));
  });
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-toggle-group], [data-home-top], [data-proto-note], [data-open-doc]');
    if (!target) return;
    if (target.dataset.toggleGroup) {
      const id = target.dataset.toggleGroup;
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      renderTree();
    } else if (target.hasAttribute('data-home-top')) {
      document.getElementById('protoContent').scrollTo({ top: 0 });
    } else if (target.dataset.protoNote) {
      toast(`‘${target.dataset.protoNote}’은(는) 시안에서 열리지 않습니다.`);
    } else if (target.dataset.openDoc) {
      openDoc(target.dataset.openDoc);
    }
  });
  return document.getElementById('protoContent');
}

let toastTimer = 0;
export function toast(message, title = '문해 · 시안') {
  const notif = document.getElementById('notif');
  if (!notif) return;
  document.getElementById('nTitle').textContent = title;
  document.getElementById('nMsg').textContent = message;
  notif.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => notif.classList.remove('show'), 2200);
}

/** Stand-in for navigating to the editor. Any element with data-open-doc="<id>" triggers this. */
export function openDoc(id) {
  const doc = getDemo().docs.find(item => item.id === id);
  if (doc) toast(`${doc.title} · ${doc.opening} — 편집기에서 엽니다.`);
}
