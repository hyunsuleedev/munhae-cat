import { DOCUMENTS, PROJECT_NODE, GROUPS, nodePath, documentPath, demoSeed, eligibleMaterials, copyComment } from './model.js';

const KEY = 'munhae:prototype:translation-materials:v1';
const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value = '') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  library:'M3 4h5l4 2 4-2h5v15h-5l-4 2-4-2H3z M12 6v15',
  file:'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
  folder:'M3 6h7l2 2h9v12H3z', arrow:'M5 12h14 M14 7l5 5-5 5',
  chevron:'m9 5 7 7-7 7', plus:'M12 5v14 M5 12h14', search:'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  close:'m6 6 12 12 M6 18 18 6', check:'m5 12 4 4L19 6', reset:'M4 10a8 8 0 1 1 1 8 M4 4v6h6',
  link:'M9 15 15 9 M7 14l-1 1a4 4 0 0 0 6 6l3-3a4 4 0 0 0 0-6 M17 10l1-1a4 4 0 0 0-6-6L9 6a4 4 0 0 0 0 6',
  comment:'M4 4h16v12H9l-5 4z M8 8h8 M8 12h5', globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18',
  down:'M12 4v16 M6 14l6 6 6-6', edit:'m5 16-1 4 4-1L20 7l-3-3z M14 7l3 3', eye:'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const doc = (id) => DOCUMENTS.find(d => d.id === id) || DOCUMENTS[0];
const groupName = id => DOCUMENTS.find(d => d.groupId === id)?.group || '예관';
const button = (label, action, id = '', cls = '', glyph = '') => `<button type="button" class="button ${cls}" data-action="${action}" data-id="${esc(id)}">${glyph ? icon(glyph) : ''}${label}</button>`;
const scopeDocs = item => DOCUMENTS.filter(d => item.scopeType === 'project' || item.scopeType === 'group' && d.groupId === item.scopeId || item.scopeType === 'document' && d.id === item.scopeId);
const scopeName = item => item.scopeType === 'project' ? '프로젝트 전체' : item.scopeType === 'group' ? `${groupName(item.scopeId)} · 하위 문서` : doc(item.scopeId).title;
const nodeIcon = type => ({project:'library',group:'folder',document:'file'}[type]);
const pathText = nodes => nodes.map(n => n.title).join(' › ');
const nodeTrail = (nodes, cls = '') => `<span class="node-trail ${cls}">${nodes.map((n,i) => `${i ? icon('chevron') : ''}<span>${esc(n.title)}</span>`).join('')}</span>`;
const materialPath = m => nodePath(m.scopeType,m.scopeId);
const nodeConnection = m => `<div class="node-connection"><span>연결 노드</span>${nodeTrail(materialPath(m))}</div>`;

function scopeTree(m, preview = false) {
  const targets = scopeDocs(m);
  const explicit = preview ? [] : DOCUMENTS.filter(d => !targets.some(t => t.id === d.id) && (state.references[d.id] || []).includes(m.id));
  const row = (n, label, cls = '', linked = false) => `<div class="scope-node ${cls}">${icon(nodeIcon(n.type))}${linked ? `<a href="#editor/${n.id}">${esc(n.title)} ${icon('chevron')}</a>` : `<span class="node-title">${esc(n.title)}</span>`}${label ? `<small>${label}</small>` : ''}</div>`;
  const documentRow = d => {
    const anchor = m.scopeType === 'document' && m.scopeId === d.id;
    const excluded = !preview && (state.excluded[d.id] || []).includes(m.id);
    return `<li>${row({...d,type:'document'},excluded ? '이 문서에서 제외' : anchor ? '연결 노드' : '하위 · 이어받음',`${anchor ? 'anchor' : 'inherited'} ${excluded ? 'is-excluded' : ''}`,!preview)}</li>`;
  };
  const groups = GROUPS.filter(g => targets.some(d => d.groupId === g.id));
  return `<div class="scope-tree" aria-label="연결 노드와 하위 문서"><ul><li>${row({...PROJECT_NODE,type:'project'},m.scopeType === 'project' ? '연결 노드' : '프로젝트',m.scopeType === 'project' ? 'anchor' : 'context')}<ul>${groups.map(g => `<li>${row({...g,type:'group'},m.scopeType === 'group' ? '연결 노드' : m.scopeType === 'project' ? '하위 권' : '상위 권',m.scopeType === 'group' ? 'anchor' : 'context')}<ul>${targets.filter(d => d.groupId === g.id).map(documentRow).join('')}</ul></li>`).join('')}</ul></li></ul></div>${explicit.length ? `<div class="cross-connections"><div class="detail-label">${icon('link')} 다른 경로에서 직접 가져온 문서</div>${explicit.map(d => `<a href="#editor/${d.id}">${nodeTrail(documentPath(d.id))}<small>${(state.excluded[d.id] || []).includes(m.id) ? '이 문서에서 제외' : '직접 참고 · 상속 관계 없음'}</small></a>`).join('')}</div>` : ''}`;
}

function documentHierarchy(d, refs) {
  return `<div class="document-hierarchy" aria-label="현재 문서의 상위 경로"><div class="detail-label">현재 문서와 상위 노드</div><ol>${documentPath(d.id).map((n,i) => {
    const matches = refs.filter(m => m.scopeType === n.type && m.scopeId === n.id && m.reason !== 'selected');
    const count = matches.filter(m => !m.excluded).length;
    return `<li style="--depth:${i}" class="${n.id === d.id ? 'current' : ''}">${icon(nodeIcon(n.type))}<span>${esc(n.title)}<small>${n.id === d.id ? '현재 노드에 둔 자료' : i === 0 ? '상위 프로젝트' : '바로 위 권'}</small></span><b>${count}${matches.length !== count ? `/${matches.length}` : ''}개</b></li>`;
  }).join('')}</ol><p>상위 노드의 자료가 아래 문서로 이어집니다.</p></div>`;
}
let state;
try { const saved = JSON.parse(localStorage.getItem(KEY)); state = saved?.materials && saved?.comments && saved?.references && saved?.excluded ? saved : demoSeed(); } catch { state = demoSeed(); }
const ui = { mode:'materials', tab:'background', docId:'doc-a', panel:'references', selected:state.materials[0].id, selectedComment:'c2', query:'', filter:'all', picker:'materials', oneOff:{}, picked:new Set(), showExcluded:true };
const openers = new Map();
let toastTimer;

function persist() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { toast('브라우저 저장 공간이 없어 이번 화면에서만 유지됩니다.'); } }
function toast(message, targetDoc) {
  clearTimeout(toastTimer);
  const el = $('#toast');
  el.innerHTML = `${icon('check')}<span>${esc(message)}</span>${targetDoc ? `<button data-action="open-editor" data-id="${targetDoc}">문서에서 확인 ${icon('arrow')}</button>` : ''}`;
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 6500);
}
function openDialog(id, html) {
  const el = $(id); openers.set(el, document.activeElement); el.innerHTML = html; el.showModal();
}
const dialogHead = (id, title, desc) => `<header class="dialog-header"><div><h2 id="${id}">${title}</h2><p>${desc}</p></div><button type="button" class="icon-button" data-action="close-dialog" aria-label="닫기">${icon('close')}</button></header>`;
function route() {
  const [page, value] = location.hash.slice(1).split('/');
  ui.mode = page === 'editor' ? 'editor' : 'materials';
  if (ui.mode === 'editor') ui.docId = doc(value).id;
  else ui.tab = ['background','glossary','comments'].includes(value) ? value : 'background';
  ui.query = ''; ui.filter = 'all'; render();
}
function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }
function renderNav() {
  $('#materialsNav').classList.toggle('active', ui.mode === 'materials');
  $('#materialsNav').setAttribute('aria-current', ui.mode === 'materials' ? 'page' : 'false');
  $('#documentNav').innerHTML = `<div class="nav-tree-root">${icon('library')}<span>${esc(PROJECT_NODE.title)}</span></div><div class="nav-tree-children">${GROUPS.map(g => `<details class="nav-branch" open><summary>${icon('chevron')}${icon('folder')}${esc(g.title)}<small>${DOCUMENTS.filter(d => d.groupId === g.id).length}</small></summary><div class="nav-documents">${DOCUMENTS.filter(d => d.groupId === g.id).map(d => `<a class="doc-link ${ui.mode === 'editor' && ui.docId === d.id ? 'active' : ''}" href="#editor/${d.id}" ${ui.mode === 'editor' && ui.docId === d.id ? 'aria-current="page"' : ''} title="${esc(pathText(documentPath(d.id)))}">${icon('file')}${esc(d.title)}</a>`).join('')}</div></details>`).join('')}</div>`;
}
function render() { renderNav(); if (ui.mode === 'materials') renderHub(); else renderEditor(); tabStops(); }
function tabStops() { document.querySelectorAll('[role=tab]').forEach(el => { el.tabIndex = el.getAttribute('aria-selected') === 'true' ? 0 : -1; }); }
function renderHub() {
  const tabData = [['background','배경·지침',state.materials.length],['glossary','용어집',state.glossary.length],['comments','코멘트',state.comments.length]];
  $('#main').innerHTML = `<header class="page-heading"><div class="breadcrumb">관제 문헌 번역 ${icon('chevron')} 프로젝트 자료</div><div class="title-row"><div><h1>번역 자료</h1><p>문헌의 배경부터 구절의 판단까지, 함께 참고할 내용을 모읍니다.</p></div>${button(ui.tab === 'glossary' ? '용어 추가' : ui.tab === 'comments' ? '문서에서 코멘트 쓰기' : '자료 추가',ui.tab === 'glossary' ? 'add-term' : ui.tab === 'comments' ? 'write-comment' : 'add-material','','primary',ui.tab === 'comments' ? 'comment' : 'plus')}</div><nav class="tabs" role="tablist" aria-label="자료 종류">${tabData.map(([key,label,n]) => `<a class="tab" role="tab" href="#materials/${key}" aria-selected="${ui.tab === key}">${label}<span class="count">${n}</span></a>`).join('')}</nav></header><div class="toolbar"><label class="search">${icon('search')}<input id="hubSearch" type="search" aria-label="자료 검색" placeholder="${ui.tab === 'comments' ? '구절이나 코멘트 검색' : ui.tab === 'glossary' ? '원문·번역 용어 검색' : '제목·내용·연결 노드 검색'}"></label>${ui.tab !== 'glossary' ? `<label class="select-wrap"><select id="hubFilter" aria-label="${ui.tab === 'comments' ? '코멘트 문서' : '자료 적용 범위'}"><option value="all">${ui.tab === 'comments' ? '모든 문서' : '모든 적용 범위'}</option>${ui.tab === 'comments' ? DOCUMENTS.map(d => `<option value="${d.id}">${esc(pathText(documentPath(d.id)))}</option>`).join('') : '<option value="project">프로젝트 전체</option><option value="group">특정 권과 하위 문서</option><option value="document">개별 문서</option><option value="comment">코멘트에서 가져옴</option>'}</select></label>` : ''}<span class="toolbar-caption">${ui.tab === 'comments' ? '원래 구절과 연결된 검토 기록' : '자료를 선택하면 내용과 적용 범위를 볼 수 있습니다'}</span></div><div class="hub-body"><section class="collection" id="collection" aria-label="자료 목록"></section><aside class="detail-pane" id="detail" aria-label="선택한 자료"></aside></div>`;
  $('#hubSearch').value = ui.query;
  if ($('#hubFilter')) $('#hubFilter').value = ui.filter;
  renderCollection(); renderDetail();
}
function materialRow(m) {
  const refs = DOCUMENTS.map(d => eligibleMaterials(state,d.id).find(r => r.id === m.id)).filter(Boolean);
  return `<button class="material-row ${ui.selected === m.id ? 'active' : ''}" data-action="select-material" data-id="${m.id}" aria-pressed="${ui.selected === m.id}">${nodeConnection(m)}<h3>${esc(m.title)}</h3><p>${esc(m.body)}</p><div class="row-bottom"><span>${m.scopeType === 'document' ? '이 문서에 직접 연결' : `↓ 하위 문서 ${scopeDocs(m).length}개에 이어짐`}</span><span>${refs.filter(r => !r.excluded).length}개 문서 사용 ${icon('chevron')}</span></div>${m.origin === 'comment' ? '<span class="origin-badge">코멘트에서 가져온 자료</span>' : ''}</button>`;
}
function commentRow(c, compact = false) { return `<article class="comment-row ${!compact && ui.selectedComment === c.id ? 'active' : ''}" ${compact ? '' : `data-action="select-comment" data-id="${c.id}" tabindex="0" role="button" aria-label="${esc(c.quote)} 코멘트"`}><div class="row-meta">${nodeTrail(documentPath(c.docId))}<span style="margin-left:auto" class="status-pill ${c.status === 'resolved' ? 'done' : ''}">${c.status === 'resolved' ? '검토 완료' : '검토 중'}</span></div><div class="quote">${esc(c.quote)}</div><p>${esc(c.body)}</p><div class="comment-footer"><span>${esc(c.author)} · ${esc(c.date)}</span>${compact ? `<button class="text-button" data-action="reuse-comment" data-id="${c.id}">${c.reusable ? '참고 자료 보기' : '다른 문서에서도 참고'} ${icon('arrow')}</button>` : c.reusable ? '<span class="scope-label">참고 자료에 연결됨</span>' : icon('chevron')}</div></article>`; }
function renderCollection() {
  const root = $('#collection'); if (!root) return;
  const q = ui.query.toLowerCase().trim();
  const matches = x => [x.title,x.body,x.condition,x.quote,x.source,x.target,x.note,x.scopeType ? pathText(materialPath(x)) : x.docId ? pathText(documentPath(x.docId)) : ''].some(v => v?.toLowerCase().includes(q));
  if (ui.tab === 'background') {
    const all = state.materials.filter(m => matches(m) && (ui.filter === 'all' || (ui.filter === 'comment' ? m.origin === 'comment' : m.scopeType === ui.filter)));
    if (!all.some(m => m.id === ui.selected)) ui.selected = all[0]?.id || null;
    const anchors = [{...PROJECT_NODE,type:'project'},...GROUPS.flatMap(g => [{...g,type:'group'},...DOCUMENTS.filter(d => d.groupId === g.id).map(d => ({...d,type:'document'}))])];
    root.innerHTML = `<div class="collection-explainer">${icon('folder')}<span>연결된 노드별 자료<small>노드 경로를 따라 자료의 위치를 확인하세요.</small></span></div>` + (anchors.map(n => {
      const list = all.filter(m => m.scopeType === n.type && m.scopeId === n.id);
      return list.length ? `<section class="node-materials" data-node="${n.id}"><div class="node-group-heading">${icon(nodeIcon(n.type))}<strong>${esc(n.title)}</strong><span>${n.type === 'project' ? '프로젝트' : n.type === 'group' ? '권' : '문서'} · 자료 ${list.length}</span></div>${list.map(materialRow).join('')}</section>` : '';
    }).join('') || `<div class="empty">${icon('search')}일치하는 자료가 없습니다.<br>검색어나 적용 범위를 바꿔 보세요.</div>`);
    if (!q && ui.filter === 'all' && !state.materials.some(m => m.origin === 'comment')) root.innerHTML += `<div class="blank-note">검토하면서 남긴 해석도 함께 모을 수 있습니다.<br><button class="text-button" data-action="try-flow">코멘트에서 참고 자료 가져오기 ${icon('arrow')}</button></div>`;
  } else if (ui.tab === 'comments') {
    const list = state.comments.filter(c => matches(c) && (ui.filter === 'all' || c.docId === ui.filter));
    if (!list.some(c => c.id === ui.selectedComment)) ui.selectedComment = list[0]?.id || null;
    root.innerHTML = `<div class="section-label">문서의 검토 기록<span class="count">${list.length}</span><span class="rule"></span></div>${list.map(c => commentRow(c)).join('') || '<div class="empty">일치하는 코멘트가 없습니다.</div>'}`;
  } else {
    const list = state.glossary.filter(matches);
    root.innerHTML = `<table class="glossary-table"><thead><tr><th>원문</th><th>번역</th><th>기준</th><th>메모</th></tr></thead><tbody>${list.map(g => `<tr><td>${esc(g.source)}</td><td>${esc(g.target)}</td><td><span class="status-pill ${g.usage === '지양' ? '' : 'done'}">${g.usage}</span></td><td>${esc(g.note)}</td></tr>`).join('')}</tbody></table>${list.length ? '' : '<div class="empty">일치하는 용어가 없습니다.</div>'}`;
  }
  renderDetail();
}
function renderDetail() {
  const el = $('#detail'); if (!el) return;
  if (ui.tab === 'comments') {
    const c = state.comments.find(c => c.id === ui.selectedComment);
    if (!c) { el.innerHTML = '<div class="empty">검색 조건에 맞는 코멘트를 선택해 주세요.</div>'; return; }
    el.innerHTML = `<div><div class="detail-top"><span>코멘트 원문</span><span class="status-pill ${c.status === 'resolved' ? 'done' : ''}">${c.status === 'resolved' ? '검토 완료' : '검토 중'}</span></div><h2>${esc(c.quote)}에 남긴 판단</h2><div class="quote">${esc(c.quote)}</div><p class="detail-body">${esc(c.body)}</p></div><div class="detail-section"><div class="detail-label">${icon('file')} 코멘트가 연결된 문서</div>${nodeTrail(documentPath(c.docId),'detail-path')}<button class="text-button" data-action="source-comment" data-id="${c.id}">${esc(doc(c.docId).title)} · 원문과 함께 보기 ${icon('arrow')}</button><p class="source-note" style="margin-top:10px">${esc(c.author)} · ${esc(c.date)}<br>작성 당시 구절과 연결된 코멘트입니다.</p></div><div class="detail-section"><div class="detail-label">다른 번역에 활용하기</div><p class="source-note">이 판단을 참고할 내용과 적용 범위를 직접 정합니다. 원래 코멘트는 그대로 남습니다.</p></div><div class="detail-actions">${button(c.reusable ? '연결된 참고 자료 보기' : '다른 문서에서도 참고', 'reuse-comment',c.id,'primary','link')}${button('문서에서 열기','open-comment-document',c.id,'','file')}</div>`;
    return;
  }
  if (ui.tab === 'glossary') {
    el.innerHTML = `<div><div class="detail-top">표현을 일관되게</div><h2>용어는 짧게,<br>조건은 분명하게.</h2><p class="detail-body">원문 표현과 번역 표현을 연결하고, 그 표현을 사용할 조건을 메모로 남깁니다.</p></div><div class="detail-section"><div class="detail-label">사용 기준</div><p class="detail-body"><b>기본</b> · 우선 사용할 표현<br><b>허용</b> · 문맥에 따라 가능한 표현<br><b>지양</b> · 다시 검토할 표현</p></div><div class="detail-section"><p class="source-note">문서별 참고 패널에서는 원문에 등장하는 용어만 함께 보여줍니다.</p></div><div class="detail-actions">${button('태상시 관제에서 확인','open-editor','doc-a','','arrow')}</div>`; return;
  }
  const m = state.materials.find(m => m.id === ui.selected);
  if (!m) { el.innerHTML = '<p class="empty">검색 조건에 맞는 자료를 선택해 주세요.</p>'; return; }
  const c = state.comments.find(c => c.id === m.sourceCommentId);
  el.innerHTML = `<div><div class="detail-top"><span>${m.origin === 'comment' ? '코멘트에서 가져온 자료' : '직접 작성한 자료'}</span><button class="icon-button" data-action="edit-material" data-id="${m.id}" title="자료 편집" aria-label="자료 편집">${icon('edit')}</button></div><h2>${esc(m.title)}</h2>${nodeConnection(m)}<div class="detail-label">${icon('folder')} 연결 노드와 하위 문서</div>${scopeTree(m)}<p class="source-note connection-rule">${m.scopeType === 'document' ? '이 문서에 직접 연결된 자료입니다.' : '연결 노드의 자료가 하위 문서로 이어집니다.'}</p></div><div class="detail-section"><div class="detail-label">참고 내용</div><p class="detail-body">${esc(m.body)}</p>${m.condition ? `<div class="detail-label" style="margin-top:16px">적용할 때 유의할 점</div><p class="source-note">${esc(m.condition)}</p>` : ''}</div>${c ? `<div class="detail-section"><div class="detail-label">${icon('link')} 근거가 된 코멘트</div><div class="quote">${esc(c.quote)}</div><p class="source-note">${nodeTrail(documentPath(c.docId))}<br>${esc(c.author)} · 원래 구절에 남긴 기록</p><button class="text-button" style="margin-top:9px" data-action="source-comment" data-id="${c.id}">원문과 코멘트 보기 ${icon('arrow')}</button></div>` : `<div class="detail-section"><p class="source-note">각 문서에서 이 자료를 따로 제외할 수 있습니다. 다른 문서의 사용 여부에는 영향을 주지 않습니다.</p></div>`}<div class="detail-actions">${button('문서에서 확인','open-editor',(scopeDocs(m).find(d => d.id === 'doc-b') || scopeDocs(m)[0]).id,'','arrow')}</div>`;
}
function renderEditor() {
  const d = doc(ui.docId);
  const sameDocument = ui.lastRenderedDoc === d.id;
  const panelScroll = sameDocument && ui.lastPanel === ui.panel ? $('#panelContent')?.scrollTop || 0 : 0;
  const documentScroll = sameDocument ? $('.manuscript')?.scrollTop || 0 : 0;
  ui.lastRenderedDoc = d.id;
  ui.lastPanel = ui.panel;
  const references = eligibleMaterials(state,d.id).filter(m => !m.excluded);
  $('#main').innerHTML = `<header class="editor-heading"><div class="breadcrumb">${nodeTrail(documentPath(d.id))}</div><div class="editor-tools">${button('전달 내용 보기','preview','','','eye')}${button('번역 자료','open-materials','','quiet','library')}</div></header><div class="editor-workspace"><article class="manuscript"><span class="eyebrow">${esc(d.group)} · ${String(DOCUMENTS.indexOf(d)+1).padStart(2,'0')}</span><h1>${esc(d.hanja)}</h1><div class="manuscript-sub">${esc(d.title)} <span style="margin:0 8px;color:#bbc0b1">/</span> 원문과 번역 대조</div><div class="folio-heading"><span>原文 <span style="margin-left:12px;letter-spacing:0">원문</span></span><span>譯文 <span style="margin-left:12px;letter-spacing:0">번역문</span></span></div>${d.sentences.map((s,i) => `<section class="sentence"><div class="source-text"><span class="line-number">${String(i+1).padStart(2,'0')}</span>${markSource(s.source,d.id)}</div><div class="translation-text"><span class="line-number">&nbsp;</span>${esc(s.translation)}</div></section>`).join('')}<p class="manuscript-foot">화면 구성을 위한 발췌문과 예시 번역입니다.</p></article><aside class="reference-panel" aria-label="문서별 참고 패널"><div class="panel-tabs" role="tablist" aria-label="문서 도구"><button class="tab" role="tab" data-action="panel-tab" data-id="references" aria-selected="${ui.panel === 'references'}">참고 자료 <span class="count">${references.length + (ui.oneOff[d.id]?.length || 0)}</span></button><button class="tab" role="tab" data-action="panel-tab" data-id="comments" aria-selected="${ui.panel === 'comments'}">코멘트 <span class="count">${state.comments.filter(c => c.docId === d.id).length}</span></button></div><div class="panel-content" id="panelContent"></div><footer class="panel-footer">${button(ui.panel === 'references' ? '다른 문서에서 가져오기' : '코멘트 추가',ui.panel === 'references' ? 'open-picker' : 'add-comment','','',ui.panel === 'references' ? 'plus' : 'comment')}<p>${ui.panel === 'references' ? '선택과 제외는 현재 문서에만 적용됩니다.' : '구절의 판단은 이 문서에 기록됩니다.'}</p></footer></aside></div>`;
  renderPanel();
  $('#panelContent').scrollTop = panelScroll;
  $('.manuscript').scrollTop = documentScroll;
}
function markSource(text, docId) {
  let result = esc(text);
  const quotes = [...new Set(state.comments.filter(c => c.docId === docId).map(c => c.quote))].sort((a,b) => b.length-a.length);
  for (const quote of quotes) if (text.includes(quote)) result = result.replace(esc(quote), `<mark>${esc(quote)}</mark>`);
  return result;
}
function renderPanel() {
  const el = $('#panelContent'); if (!el) return;
  const d = doc(ui.docId);
  if (ui.panel === 'comments') { el.innerHTML = `<div class="panel-intro"><h2>이 문서의 코멘트</h2></div><p class="inline-note">원문 구절에 남긴 해석과 검토 의견</p>${state.comments.filter(c => c.docId === d.id).map(c => commentRow(c,true)).join('') || '<div class="empty">아직 코멘트가 없습니다.</div>'}`; return; }
  const refs = eligibleMaterials(state,d.id);
  const groups = [['project','상위 프로젝트',PROJECT_NODE.title],['group','상위 권',d.group],['direct','현재 문서',d.title],['selected','다른 노드에서 직접 가져옴','상속 관계 없이 선택한 참고 자료']];
  const oneOff = (ui.oneOff[d.id] || []).map(id => state.comments.find(c => c.id === id)).filter(Boolean);
  el.innerHTML = `<div class="panel-intro"><h2>이번 번역의 참고 자료</h2><span>${refs.filter(m => !m.excluded).length + oneOff.length}개 사용</span></div>${documentHierarchy(d,refs)}${groups.map(([key,title,nodeTitle]) => {
    const all = refs.filter(m => m.reason === key);
    const list = all.filter(m => !m.excluded || ui.showExcluded);
    return list.length ? `<div class="ref-group-heading node-ref-heading"><div><span>${title}</span><strong>${esc(nodeTitle)}</strong></div><span>${all.filter(m => !m.excluded).length}/${all.length}개</span></div>${list.map(refCard).join('')}` : '';
  }).join('')}${oneOff.length ? `<div class="ref-group-heading"><span>이번 번역에서만 참고</span><button class="text-button" data-action="clear-oneoff">비우기</button></div>${oneOff.map(c => `<div class="ref-card"><div class="ref-title"><span>${esc(c.quote)}에 남긴 코멘트</span><button class="icon-button" data-action="remove-oneoff" data-id="${c.id}" aria-label="이번 참고에서 제외">${icon('close')}</button></div><p style="margin-left:0">${esc(c.body)}</p><div class="ref-meta" style="margin-left:0"><span>${nodeTrail(documentPath(c.docId))}<br>이번만 참고</span><button data-action="source-comment" data-id="${c.id}">원본 보기 ↗</button></div></div>`).join('')}` : ''}${refs.some(m => m.excluded) ? `<label class="ref-toggle"><input type="checkbox" id="showExcluded" ${ui.showExcluded ? 'checked' : ''}>이 문서에서 제외한 자료도 보기</label>` : ''}${renderTerms(d)}`;
}
function refCard(m) {
  const c = state.comments.find(c => c.id === m.sourceCommentId);
  return `<div class="ref-card ${m.excluded ? 'excluded' : ''}"><div class="ref-node-origin">${icon(m.reason === 'selected' ? 'link' : m.reason === 'direct' ? 'file' : 'down')}<span>${m.reason === 'selected' ? '다른 노드의 자료를 직접 연결' : m.reason === 'direct' ? '현재 문서에 연결됨' : '상위에서 이어받음'}${nodeTrail(materialPath(m))}</span></div><div class="ref-title"><label><input type="checkbox" data-reference="${m.id}" ${m.excluded ? '' : 'checked'} aria-label="${esc(m.title)} · 이 문서에서 참고"><span>${esc(m.title)}</span></label></div><p>${esc(m.body)}</p>${m.condition ? `<div class="ref-condition">${esc(m.condition)}</div>` : ''}<div class="ref-meta"><span>${m.excluded ? '<span class="excluded-label">이 문서에서 제외됨</span>' : c ? `${esc(doc(c.docId).title)} · 코멘트에서` : esc(scopeName(m))}</span><button data-action="${c ? 'source-comment' : 'source-material'}" data-id="${c?.id || m.id}">${c ? '원본 보기' : '내용 보기'} ↗</button></div></div>`;
}
function renderTerms(d) { const source = d.sentences.map(s => s.source).join(''); const terms = state.glossary.filter(g => source.includes(g.source)); return terms.length ? `<div class="ref-group-heading"><span>원문에 등장하는 용어</span><a href="#materials/glossary">용어집 ↗</a></div>${terms.map(g => `<div class="term-inline"><span class="serif">${esc(g.source)}</span><span>→ ${esc(g.target)}</span><small>${esc(g.usage)}</small></div>`).join('')}` : ''; }

function editMaterial({ commentId, materialId } = {}) {
  const c = state.comments.find(c => c.id === commentId);
  const current = state.materials.find(m => m.id === materialId);
  const origin = c || state.comments.find(c => c.id === current?.sourceCommentId);
  const initial = current || {title:c ? `${c.quote}에 관한 검토` : '', body:c?.body || '', condition:'', scopeType: c ? 'group' : 'project', scopeId:c ? doc(c.docId).groupId : 'project'};
  const title = current ? '참고 자료 편집' : c ? '다른 문서에서도 참고' : '배경·지침 추가';
  openDialog('#editDialog', `<form id="materialForm">${dialogHead('editTitle',title,c ? '코멘트를 바탕으로 참고할 내용과 범위를 정합니다.' : '번역할 때 함께 참고할 내용을 남깁니다.')}<div class="dialog-body">${origin ? `<div class="original-comment"><div class="detail-label">${icon('comment')} 원본 코멘트</div>${nodeTrail(documentPath(origin.docId),'detail-path')}<div class="quote">${esc(origin.quote)}</div><p>${esc(origin.body)}</p></div>` : ''}<div class="field"><label for="materialTitle">자료 제목</label><input id="materialTitle" name="title" value="${esc(initial.title)}" placeholder="예: 제례 관서의 이름을 옮길 때" required maxlength="150"></div><div class="field"><label for="materialBody">함께 참고할 내용</label><textarea id="materialBody" name="body" rows="3" required>${esc(initial.body)}</textarea></div><div class="field"><label for="materialCondition">적용 조건·예외 <span class="muted" style="font-weight:400">선택</span></label><input id="materialCondition" name="condition" value="${esc(initial.condition)}" placeholder="예: 다른 시대의 관제 인용에는 적용하지 않음"></div><div class="field-label">어디에서 참고할까요?</div><div class="scope-options">${[['document','한 문서','선택한 글에서만'],['group','특정 권','그 아래 문서까지'],['project','프로젝트 전체','모든 문서에서']].map(([key,label,sub]) => `<label class="scope-option"><input type="radio" name="scope" value="${key}" ${initial.scopeType === key ? 'checked' : ''}><strong>${label}</strong><small>${sub}</small></label>`).join('')}</div><div id="scopeTarget"></div><div id="scopePreview" class="scope-preview"></div></div><footer class="dialog-footer"><span class="inline-note">${origin ? '원래 코멘트는 그대로 남습니다.' : '자료는 데모에만 저장됩니다.'}</span>${button('취소','close-dialog')}<button class="button primary" type="submit">${current ? '변경 저장' : '참고 자료에 추가'}</button></footer></form>`);
  const form = $('#materialForm'); let scopeValue = initial.scopeId;
  const updatePreview = () => {
    const type = form.elements.scope.value;
    scopeValue = $('#scopeSelect',form)?.value || 'project';
    const scope = {scopeType:type,scopeId:scopeValue};
    $('#scopePreview').innerHTML = `<div class="scope-preview-heading">연결 위치와 이어받을 문서 · ${scopeDocs(scope).length}개</div>${scopeTree(scope,true)}`;
  };
  const updateTarget = () => {
    const type = form.elements.scope.value;
    const options = type === 'document' ? DOCUMENTS.map(d => [d.id,pathText(documentPath(d.id))]) : GROUPS.map(g => [g.id,pathText(nodePath('group',g.id))]);
    if (!options.some(([value]) => value === scopeValue)) scopeValue = type === 'document' ? (c?.docId || ui.docId) : (c ? doc(c.docId).groupId : doc(ui.docId).groupId);
    $('#scopeTarget').innerHTML = type === 'project' ? '' : `<div class="field" style="margin-bottom:0"><label class="sr-only" for="scopeSelect">${type === 'document' ? '대상 문서' : '대상 권'}</label><select id="scopeSelect">${options.map(([value,label]) => `<option value="${value}" ${value === scopeValue ? 'selected' : ''}>${label}</option>`).join('')}</select></div>`;
    $('#scopeSelect')?.addEventListener('change',updatePreview); updatePreview();
  };
  form.querySelectorAll('[name=scope]').forEach(el => el.addEventListener('change',updateTarget)); updateTarget();
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const input = {title:form.elements.title.value.trim(),body:form.elements.body.value.trim(),condition:form.elements.condition.value.trim(),scopeType:form.elements.scope.value,scopeId:scopeValue};
    if (!input.title || !input.body) { toast('제목과 내용을 입력해 주세요.'); return; }
    let saved;
    if (current) { Object.assign(current,input); saved=current; }
    else if (c) saved=copyComment(state,{commentId:c.id,...input});
    else { saved={...input,id:`material-manual-${Date.now()}`,origin:'manual',sourceCommentId:null,createdAt:new Date().toISOString()};state.materials.push(saved); }
    persist(); $('#editDialog').close(); ui.selected=saved.id;
    navigate('#materials/background');
    const target=scopeDocs(saved).find(d => d.id !== c?.docId) || scopeDocs(saved)[0];
    toast(current ? '참고 자료를 수정했습니다.' : '참고 자료에 추가했습니다.',target?.id);
  });
}
function reuseComment(id) {
  const existing=state.materials.find(m => m.sourceCommentId === id);
  if(existing) { ui.selected=existing.id;navigate('#materials/background'); }
  else editMaterial({commentId:id});
}
function openSource(kind,id) {
  const c = state.comments.find(c => c.id === id);
  const m = state.materials.find(m => m.id === id);
  const content = kind === 'comment' && c ? `<div class="row-meta">${nodeTrail(documentPath(c.docId))} · ${esc(c.date)}</div><div class="quote">${esc(doc(c.docId).sentences.find(s => s.source.includes(c.quote))?.source || c.quote)}</div><div class="detail-label" style="margin-top:23px">선택 구절 · ${esc(c.quote)}</div><p class="detail-body">${esc(c.body)}</p><p class="source-note" style="margin-top:20px">${esc(c.author)} · ${c.status === 'open' ? '검토 중' : '검토 완료'}<br>다른 문서의 참고 자료로 사용해도 원래 기록은 바뀌지 않습니다.</p>` : m ? `${nodeConnection(m)}<h3 style="margin:15px 0">${esc(m.title)}</h3><p class="detail-body">${esc(m.body)}</p>${m.condition ? `<div class="detail-section" style="margin-top:20px"><div class="detail-label">적용 조건·예외</div><p class="source-note">${esc(m.condition)}</p></div>` : ''}` : '';
  openDialog('#sourceDialog',`${dialogHead('sourceTitle',kind === 'comment' ? '원문과 코멘트' : '참고 내용','기록이 만들어진 맥락을 함께 확인합니다.')}<div class="dialog-body">${content}</div><footer class="dialog-footer">${button('닫기','close-dialog')}${c ? button('원래 문서 열기','source-open-document',c.docId,'primary','arrow') : ''}</footer>`);
}
function openPicker() { ui.picker='materials';ui.picked=new Set();renderPicker(true); }
function renderPicker(first=false) {
  const d=doc(ui.docId), present=new Set(eligibleMaterials(state,d.id).map(m=>m.id));
  const materials=state.materials.filter(m=>!present.has(m.id));
  const comments=state.comments.filter(c=>c.docId!==d.id && !(ui.oneOff[d.id]||[]).includes(c.id));
  const rows=ui.picker==='materials'?materials:comments;
  const html=`${dialogHead('pickerTitle','다른 문서에서 가져오기',`${esc(d.title)}에서 참고할 내용을 직접 선택합니다.`)}<nav class="dialog-subnav" role="tablist" aria-label="가져올 자료 종류"><button class="tab" role="tab" aria-selected="${ui.picker==='materials'}" data-action="picker-tab" data-id="materials">배경·지침 <span class="count">${materials.length}</span></button><button class="tab" role="tab" aria-selected="${ui.picker==='comments'}" data-action="picker-tab" data-id="comments">원문 코멘트 <span class="count">${comments.length}</span></button></nav><div class="dialog-body"><p class="inline-note">${ui.picker==='materials'?'원래 적용 범위를 확인하고 참고 사례로 연결합니다. 다른 문서의 지침을 그대로 적용할 필요는 없습니다.':'과거 구절에 대한 의견을 이번 번역의 참고 사례로 가져옵니다.'}</p>${rows.map(item=>`<label class="picker-row"><input type="checkbox" data-pick="${item.id}" ${ui.picked.has(item.id)?'checked':''}><span><small>${ui.picker==='materials'?'자료 연결 노드':'코멘트 원문 노드'} ${nodeTrail(ui.picker==='materials'?materialPath(item):documentPath(item.docId))}</small><strong>${esc(item.title||item.quote)}</strong><p>${esc(item.body)}</p></span></label>`).join('')||'<div class="empty">이미 적용 범위에 있는 자료는<br>현재 문서의 참고 패널에서 선택할 수 있습니다.</div>'}</div><footer class="dialog-footer"><span class="inline-note" id="pickCount">${ui.picked.size}개 선택</span>${button('취소','close-dialog')}<button class="button primary" data-action="confirm-picker" ${ui.picked.size?'':'disabled'}>${ui.picker==='materials'?'이 문서에 연결':'이번 번역에 참고'}</button></footer>`;
  if(first)openDialog('#pickerDialog',html);else $('#pickerDialog').innerHTML=html;
  tabStops();
}
function showPreview() {
  const d=doc(ui.docId), refs=eligibleMaterials(state,d.id).filter(m=>!m.excluded), comments=(ui.oneOff[d.id]||[]).map(id=>state.comments.find(c=>c.id===id)).filter(Boolean), terms=state.glossary.filter(g=>d.sentences.some(s=>s.source.includes(g.source)));
  openDialog('#previewDialog',`${dialogHead('previewTitle','이번 번역에 전달할 내용',`${esc(d.title)} · 참고 자료 미리보기`)}<div class="dialog-body"><div class="preview-summary">배경·지침 ${refs.length}개 · 이번만 참고 ${comments.length}개 · 관련 용어 ${terms.length}개<br>원문 전문과 함께 아래 내용을 참고합니다.</div>${refs.map(m=>{const c=state.comments.find(c=>c.id===m.sourceCommentId);return `<section class="preview-block"><div class="detail-label">${nodeTrail(materialPath(m))} ${m.reason==='selected'?'· 다른 노드에서 직접 연결':m.reason==='direct'?'· 현재 문서':'· 상위에서 이어받음'}</div><h3>${esc(m.title)}</h3><p>${esc(m.body)}</p>${m.condition?`<p style="color:var(--bronze);margin-top:8px">적용 조건 · ${esc(m.condition)}</p>`:''}${c?`<div class="quote">${esc(c.quote)}</div><div class="preview-source">근거 · ${esc(pathText(documentPath(c.docId)))}의 코멘트 · 원래 구절에 대한 판단</div>`:''}</section>`}).join('')}${comments.map(c=>`<section class="preview-block"><div class="detail-label">이번 번역에서만 · 과거 검토 사례</div>${nodeTrail(documentPath(c.docId),'detail-path')}<h3>${esc(doc(c.docId).title)}</h3><div class="quote">${esc(doc(c.docId).sentences.find(s=>s.source.includes(c.quote))?.source || c.quote)}</div><p>${esc(c.body)}</p><div class="preview-source">위 원문 구절에서 나온 의견입니다. 현재 글에도 적용되는지 문맥을 대조해야 합니다.</div></section>`).join('')}${terms.length?`<section class="preview-block"><h3>원문에 등장하는 용어</h3>${terms.map(g=>`<p>${esc(g.source)} → ${esc(g.target)} (${g.usage})<br><span class="muted">${esc(g.note)}</span></p>`).join('')}</section>`:''}<p class="demo-caption">데모에서는 AI에 전송하지 않습니다.</p></div><footer class="dialog-footer">${comments.length?button('이번만 참고 비우기','preview-clear-oneoff','','quiet'):''}${button('확인','close-dialog','','primary')}</footer>`);
}
function addTerm() {
  openDialog('#editDialog',`<form id="termForm">${dialogHead('editTitle','용어 추가','원문과 번역 표현을 연결합니다.')}<div class="dialog-body"><div class="field"><label for="termSource">원문 표현</label><input name="source" id="termSource" required></div><div class="field"><label for="termTarget">번역 표현</label><input name="target" id="termTarget" required></div><div class="field"><label for="termUsage">사용 기준</label><select name="usage" id="termUsage"><option>기본</option><option>허용</option><option>지양</option></select></div><div class="field"><label for="termNote">메모</label><textarea name="note" id="termNote" rows="3" placeholder="어떤 문맥에서 사용하는 표현인가요?"></textarea></div></div><footer class="dialog-footer">${button('취소','close-dialog')}<button type="submit" class="button primary">추가</button></footer></form>`);
  $('#termForm').addEventListener('submit',e=>{e.preventDefault();const f=e.currentTarget;const source=f.elements.source.value.trim(),target=f.elements.target.value.trim();if(!source||!target)return;state.glossary.push({id:`glossary-${Date.now()}`,source,target,usage:f.elements.usage.value,note:f.elements.note.value.trim()});persist();$('#editDialog').close();render();toast('용어를 추가했습니다.');});
}
function addComment() {
  const d=doc(ui.docId);
  openDialog('#editDialog',`<form id="commentForm">${dialogHead('editTitle','이 문서에 코멘트 남기기',`${esc(d.title)} · 원문 구절에 검토 의견을 연결합니다.`)}<div class="dialog-body"><div class="quote">${d.sentences.map(s=>esc(s.source)).join('<br>')}</div><div class="field"><label for="commentQuote">코멘트를 달 원문 구절</label><input name="quote" id="commentQuote" value="${esc(d.sentences[0].source.slice(0,4))}" required></div><div class="field"><label for="commentBody">검토 의견</label><textarea name="body" id="commentBody" rows="4" required placeholder="해석, 수정할 내용, 확인할 근거를 적어 주세요."></textarea></div><p class="inline-note" id="commentError" role="status"></p></div><footer class="dialog-footer">${button('취소','close-dialog')}<button type="submit" class="button primary">코멘트 저장</button></footer></form>`);
  $('#commentForm').addEventListener('submit',e=>{e.preventDefault();const f=e.currentTarget,quote=f.elements.quote.value.trim(),body=f.elements.body.value.trim();if(!quote||!body)return;if(!d.sentences.some(s=>s.source.includes(quote))){$('#commentError').textContent='이 문서 원문에 있는 구절을 입력해 주세요.';return;}state.comments.push({id:`comment-${Date.now()}`,docId:d.id,quote,body,status:'open',author:'이현수',date:'방금',reusable:false});persist();$('#editDialog').close();ui.panel='comments';render();toast('코멘트를 저장했습니다.');});
}

document.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]'); if(!target)return;
  const {action,id}=target.dataset;
  if(action==='select-material'){ui.selected=id;renderCollection();renderDetail();document.querySelector(`[data-action="select-material"][data-id="${id}"]`)?.focus({preventScroll:true});}
  else if(action==='select-comment'){ui.selectedComment=id;renderCollection();renderDetail();document.querySelector(`[data-action="select-comment"][data-id="${id}"]`)?.focus({preventScroll:true});}
  else if(action==='close-dialog')target.closest('dialog').close();
  else if(action==='add-material')editMaterial();
  else if(action==='edit-material')editMaterial({materialId:id});
  else if(action==='reuse-comment')reuseComment(id);
  else if(action==='source-comment')openSource('comment',id);
  else if(action==='source-material')openSource('material',id);
  else if(action==='open-editor'){ui.panel='references';navigate(`#editor/${id}`);$('#toast').hidden=true;}
  else if(action==='source-open-document'){target.closest('dialog').close();ui.panel='comments';navigate(`#editor/${id}`);}
  else if(action==='open-comment-document'){ui.panel='comments';navigate(`#editor/${state.comments.find(c=>c.id===id).docId}`);}
  else if(action==='open-materials')navigate('#materials/background');
  else if(action==='write-comment'){ui.panel='comments';navigate(`#editor/${ui.docId}`);}
  else if(action==='panel-tab'){ui.panel=id;renderEditor();tabStops();document.querySelector(`[data-action="panel-tab"][data-id="${id}"]`)?.focus({preventScroll:true});}
  else if(action==='try-flow'){ui.selectedComment='c2';navigate('#materials/comments');}
  else if(action==='add-term')addTerm();
  else if(action==='add-comment')addComment();
  else if(action==='open-picker')openPicker();
  else if(action==='picker-tab'){ui.picker=id;ui.picked=new Set();renderPicker();}
  else if(action==='confirm-picker'){
    if(ui.picker==='materials'){state.references[ui.docId]=[...new Set([...(state.references[ui.docId]||[]),...ui.picked])];persist();}
    else ui.oneOff[ui.docId]=[...new Set([...(ui.oneOff[ui.docId]||[]),...ui.picked])];
    const n=ui.picked.size;$('#pickerDialog').close();renderEditor();toast(`${n}개 ${ui.picker==='materials'?'자료를 이 문서에 연결했습니다.':'코멘트를 이번 번역의 참고에 추가했습니다.'}`);
  }
  else if(action==='preview')showPreview();
  else if(action==='remove-oneoff'){ui.oneOff[ui.docId]=ui.oneOff[ui.docId].filter(x=>x!==id);renderEditor();}
  else if(action==='clear-oneoff'||action==='preview-clear-oneoff'){ui.oneOff[ui.docId]=[];if(action==='preview-clear-oneoff')$('#previewDialog').close();renderEditor();toast('이번만 참고할 코멘트를 비웠습니다.');}
});
document.addEventListener('input',event=>{if(event.target.id==='hubSearch'){ui.query=event.target.value;renderCollection();}});
document.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='hubFilter'){ui.filter=el.value;renderCollection();}
  if(el.dataset.reference){const set=new Set(state.excluded[ui.docId]||[]);if(el.checked)set.delete(el.dataset.reference);else set.add(el.dataset.reference);state.excluded[ui.docId]=[...set];persist();renderEditor();document.querySelector(`[data-reference="${el.dataset.reference}"]`)?.focus({preventScroll:true});toast(el.checked?'이 문서에서 다시 참고합니다.':'이 문서에서만 제외했습니다. 다른 문서에는 유지됩니다.');}
  if(el.id==='showExcluded'){ui.showExcluded=el.checked;renderPanel();}
  if(el.dataset.pick){el.checked?ui.picked.add(el.dataset.pick):ui.picked.delete(el.dataset.pick);$('#pickCount').textContent=`${ui.picked.size}개 선택`;$('[data-action=confirm-picker]').disabled=!ui.picked.size;}
});
document.addEventListener('keydown',event=>{
  document.documentElement.dataset.keyboard='';
  if(event.key==='Escape'){
    const dialog=[...document.querySelectorAll('dialog[open]')].at(-1);
    if(dialog){event.preventDefault();dialog.close();}
  }
  if((event.key==='Enter'||event.key===' ')&&event.target.matches('.comment-row[role=button]')){event.preventDefault();event.target.click();}
  if(event.key===' '&&event.target.matches('a[role=tab]')){event.preventDefault();event.target.click();}
  if(event.target.matches('[role=tab]')&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
    event.preventDefault();
    const tabs=[...event.target.closest('[role=tablist]').querySelectorAll('[role=tab]')];
    const index=tabs.indexOf(event.target);
    const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length];
    next.focus();
  }
});
document.addEventListener('pointerdown',()=>delete document.documentElement.dataset.keyboard);
document.querySelectorAll('dialog').forEach(el=>el.addEventListener('close',()=>{const opener=openers.get(el);if(opener?.isConnected)opener.focus();else $('#main .tab[aria-selected=true]')?.focus();}));
$('#tryFlow').addEventListener('click',()=>{ui.selectedComment='c2';navigate('#materials/comments');});
$('#resetDemo').addEventListener('click',()=>{
  openDialog('#sourceDialog',`${dialogHead('sourceTitle','데모를 처음 상태로','이 데모에서 추가하거나 선택한 내용만 초기화합니다.')}<div class="dialog-body"><p class="detail-body">예시 자료 4개와 코멘트 5개로 되돌립니다.</p></div><footer class="dialog-footer">${button('취소','close-dialog')}<button class="button primary" id="confirmReset">데모 초기화</button></footer>`);
  $('#confirmReset').addEventListener('click',()=>{state=demoSeed();ui.oneOff={};ui.selected=state.materials[0].id;ui.selectedComment='c2';persist();$('#sourceDialog').close();navigate('#materials/background');toast('데모를 초기화했습니다.');});
});
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
window.addEventListener('hashchange',route);
route();
