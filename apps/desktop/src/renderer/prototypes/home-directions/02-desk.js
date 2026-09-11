import { getDemo, mountShell, badge, progress, esc } from './shared.js';

const demo = getDemo();
const { project, docs, stats, recent, issues } = demo;
const arrow = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="M4 10h11M10 5l5 5-5 5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const reviewDocs = docs.filter(doc => doc.needsReview);
const activeDocs = docs.filter(doc => !doc.confirmed);
const resume = docs.find(doc => doc.id === recent[0]?.docId) || activeDocs[0] || docs[0];
const recentResume = recent.find(item => item.docId === resume?.id);
let selectedTab = activeDocs.length ? 'active' : 'all';
let query = '';
let expanded = false;

function resumePanel() {
  if (!resume) return `<section class="desk-resume desk-start"><div class="eyebrow">첫 작업을 시작하세요</div><h2>한 문서에서 시작하는<br>번역의 책상</h2><p>원문을 준비하고, 구두를 달고, 번역을 다듬어 보세요.<br>다음에 돌아오면 마지막 작업을 여기서 이어갈 수 있습니다.</p><button class="btn primary" data-panel="add">첫 문서 준비하기 ${arrow}</button></section>`;
  return `<section class="desk-resume" aria-labelledby="resume-heading">
    <div class="desk-panel-top"><span class="eyebrow">마지막 작업 이어가기</span><span class="desk-time">${esc(recentResume?.when || resume.updated)}</span></div>
    <div class="desk-resume-title"><span class="desk-chapter">${esc(resume.chapter)}</span><h2 id="resume-heading" class="serif">${esc(resume.title)}</h2><p>${esc(resume.ko)}</p></div>
    <div class="desk-excerpt"><span>원문</span><p class="serif">${esc(resume.excerpt)}</p></div>
    <div class="desk-resume-footer"><div>${badge(resume)}<span class="desk-resume-note">${resume.needsReview ? '검토할 내용이 남아 있어요' : resume.confirmed ? '확정한 내용을 다시 살펴보세요' : '마지막 작업에서 계속하세요'}</span></div><button class="btn primary" data-doc="${esc(resume.id)}">이어서 작업하기 ${arrow}</button></div>
  </section>`;
}

function inboxPanel() {
  const available = issues.slice(0, 3);
  return `<section class="desk-inbox" aria-labelledby="inbox-heading"><div class="desk-panel-top"><h2 id="inbox-heading">확인이 필요한 일 <span class="desk-count">${issues.length}</span></h2><span class="desk-small-label">검토함</span></div>
    ${available.length ? `<div class="desk-issue-list">${available.map((issue, index) => `<button class="desk-issue" data-doc="${esc(issue.docId)}"><span class="desk-issue-number">${String(index + 1).padStart(2, '0')}</span><span><strong>${esc(issue.title)}</strong><span class="desk-issue-body">${esc(issue.body)}</span></span><span class="desk-issue-arrow">${arrow}</span></button>`).join('')}</div><button class="desk-text-button desk-inbox-all" data-desk-tab="review">검토 문서 ${reviewDocs.length}개 보기 ${arrow}</button>` : `<div class="desk-inbox-clear"><span class="desk-clear-mark" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="m6 12 4 4 8-8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><h3>${docs.length ? '확인할 일이 없습니다' : '검토할 내용을 모아 드려요'}</h3><p>${docs.length ? '문서의 검토 사항이 생기면<br>이곳에서 바로 살펴볼 수 있습니다.' : '번역의 미해결 사항과 검토 요청을<br>한곳에서 확인할 수 있습니다.'}</p></div>`}
  </section>`;
}

function summaryPanel() {
  return `<aside class="desk-project-rail" aria-label="프로젝트 요약"><section class="desk-project-brief"><div class="desk-panel-top"><h2>프로젝트 한눈에</h2><button class="desk-small-button" data-panel="project" aria-label="프로젝트 정보 자세히 보기">${arrow}</button></div><p class="desk-description">${esc(project.description)}</p><dl class="desk-project-facts"><div><dt>작업 범위</dt><dd>${esc(project.scope)}</dd></div><div><dt>시대·주제</dt><dd>${esc(project.period)}</dd></div></dl><div class="desk-progress-label"><span>번역 확정</span><strong>${stats.confirmed}<small> / ${stats.total}편</small></strong></div>${progress(stats.confirmed, stats.total)}<div class="desk-stage-totals"><span>원문 <b>${stats.source}</b></span><span>구두 <b>${stats.punctuation}</b></span><span>번역 <b>${stats.translation}</b></span></div><div class="desk-reference-links"><button data-panel="context"><span>공통 문맥</span>${arrow}</button><button data-panel="notes"><span>프로젝트 노트</span>${arrow}</button></div></section>
  <section class="desk-recent"><div class="desk-panel-top"><h2>최근 작업</h2></div>${recent.length ? `<ol>${recent.slice(0, 3).map(item => `<li><span class="desk-history-dot"></span><button data-doc="${esc(item.docId)}"><strong>${esc(item.title)}</strong><span>${esc(item.action)}</span><time>${esc(item.when)}</time></button></li>`).join('')}</ol>` : '<p class="desk-quiet">작업을 시작하면 기록이 쌓입니다.</p>'}</section></aside>`;
}

mountShell('02-desk', `<main class="desk-page">
  <header class="desk-page-header"><div><div class="eyebrow">오늘의 책상</div><h1>${esc(project.title)}</h1><p>${esc(project.subtitle)}</p></div><button class="btn desk-project-button" data-panel="project">프로젝트 정보 ${arrow}</button></header>
  <div class="desk-priority-grid">${resumePanel()}${inboxPanel()}</div>
  <div class="desk-work-grid"><section class="desk-work" aria-labelledby="work-heading"><div class="desk-work-heading"><h2 id="work-heading">내 작업 <span>${docs.length}편</span></h2><button class="desk-text-button" data-panel="add">+ 문서 추가</button></div><div class="desk-work-controls"><div class="desk-tabs" role="tablist" aria-label="문서 상태"><button id="desk-tab-active" role="tab" aria-controls="desk-doc-panel" data-desk-tab="active">작업 중 <span>${activeDocs.length}</span></button><button id="desk-tab-review" role="tab" aria-controls="desk-doc-panel" data-desk-tab="review">검토 필요 <span>${reviewDocs.length}</span></button><button id="desk-tab-all" role="tab" aria-controls="desk-doc-panel" data-desk-tab="all">전체 <span>${docs.length}</span></button></div><label class="desk-search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.4"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><input id="desk-search" type="search" aria-label="문서 또는 목차 검색" placeholder="문서 또는 목차 검색" autocomplete="off"></label></div><div id="desk-doc-panel" class="desk-document-panel" role="tabpanel" tabindex="0"><div id="desk-doc-list"></div></div><div id="desk-list-footer" class="desk-list-footer"></div></section>${summaryPanel()}</div>
</main>`);

function renderDocs() {
  document.querySelectorAll('.desk-tabs [data-desk-tab]').forEach(button => {
    const isSelected = button.dataset.deskTab === selectedTab;
    button.setAttribute('aria-selected', String(isSelected));
    button.tabIndex = isSelected ? 0 : -1;
  });
  document.getElementById('desk-doc-panel').setAttribute('aria-labelledby', `desk-tab-${selectedTab}`);
  const tabDocs = selectedTab === 'review' ? reviewDocs : selectedTab === 'active' ? activeDocs : docs;
  const needle = query.toLocaleLowerCase();
  const filtered = tabDocs.filter(doc => `${doc.title} ${doc.ko} ${doc.chapter}`.toLocaleLowerCase().includes(needle));
  const shown = expanded ? filtered : filtered.slice(0, 9);
  const list = document.getElementById('desk-doc-list');
  if (shown.length) {
    list.innerHTML = `<div class="desk-list-labels" aria-hidden="true"><span>문서 / 목차</span><span>작업 상태</span><span>최근 작업</span><span></span></div>${shown.map(doc => `<button class="desk-document" data-doc="${esc(doc.id)}"><span class="desk-document-name"><strong class="serif">${esc(doc.title)}</strong><span>${esc(doc.ko)}<i>·</i>${esc(doc.chapter)}</span></span><span class="desk-document-stage">${badge(doc)}</span><span class="desk-document-time">${esc(doc.updated)}</span><span class="desk-document-arrow">${arrow}</span></button>`).join('')}`;
  } else {
    list.innerHTML = `<div class="desk-no-documents"><h3>${query ? '검색한 문서가 없습니다' : docs.length ? '이 상태의 문서가 없습니다' : '첫 문서를 기다리고 있어요'}</h3><p>${query ? '문서 제목이나 목차 이름으로 다시 찾아보세요.' : docs.length ? '다른 작업 상태를 선택해 문서를 살펴보세요.' : '원문을 추가하면 작업 상태와 진행 상황을 함께 볼 수 있습니다.'}</p>${!docs.length ? '<button class="btn" data-panel="add">문서 준비하기</button>' : '<button class="desk-text-button" data-desk-reset>전체 문서 보기</button>'}</div>`;
  }
  document.getElementById('desk-list-footer').innerHTML = `<span role="status" aria-live="polite">${filtered.length ? `${filtered.length}편 중 ${shown.length}편 표시` : `${filtered.length}편`}</span>${filtered.length > 9 ? `<button class="desk-text-button" data-desk-expand>${expanded ? '간략히 보기' : `나머지 ${filtered.length - shown.length}편 보기`} ${arrow}</button>` : ''}`;
}

document.addEventListener('click', event => {
  const tab = event.target.closest('[data-desk-tab]');
  if (tab) {
    selectedTab = tab.dataset.deskTab;
    expanded = false;
    renderDocs();
    if (!tab.closest('.desk-tabs')) document.getElementById('work-heading').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  if (event.target.closest('[data-desk-expand]')) { expanded = !expanded; renderDocs(); }
  if (event.target.closest('[data-desk-reset]')) { selectedTab = 'all'; query = ''; expanded = false; document.getElementById('desk-search').value = ''; renderDocs(); }
});
document.getElementById('desk-search').addEventListener('input', event => { query = event.target.value.trim(); expanded = false; renderDocs(); });
document.querySelector('.desk-tabs').addEventListener('keydown', event => {
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...document.querySelectorAll('.desk-tabs [data-desk-tab]')];
  const position = tabs.findIndex(tab => tab.dataset.deskTab === selectedTab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (position + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectedTab = tabs[next].dataset.deskTab;
  expanded = false;
  renderDocs();
  tabs[next].focus();
});
renderDocs();
