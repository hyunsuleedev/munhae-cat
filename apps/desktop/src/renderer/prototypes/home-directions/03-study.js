import { getDemo, mountShell, badge, progress, esc } from './shared.js';

const demo = getDemo();
const { project, docs, chapters, stats, recent } = demo;
const arrow = '<span aria-hidden="true">↗</span>';
const stages = [
  ['source', '원문'], ['punctuation', '표점'], ['draft', '초벌 번역'],
  ['review', '검토'], ['confirmed', '확정'],
];
const stageCounts = stages.map(([key]) => docs.filter(doc => doc.stage === key).length);
const percent = stats.total ? Math.round(stats.confirmed / stats.total * 100) : 0;
const chapterDocs = chapter => docs.filter(doc => doc.chapterId === chapter.id);
const recentDocs = [...new Set([...recent.map(item => item.docId), ...docs.map(doc => doc.id)])]
  .map(id => docs.find(doc => doc.id === id)).filter(Boolean).slice(0, 3);

function chapterRow(chapter, index) {
  const entries = chapterDocs(chapter);
  const confirmed = entries.filter(doc => doc.confirmed).length;
  return `<article class="study-chapter" ${index >= 6 ? 'data-extra-chapter hidden' : ''}>
    <button class="study-chapter-toggle" data-toggle-chapter="${esc(chapter.id)}" aria-expanded="false" aria-controls="chapter-${esc(chapter.id)}">
      <span class="study-chapter-number mono">${String(index + 1).padStart(2, '0')}</span>
      <span class="study-chapter-name"><strong>${esc(chapter.subtitle || chapter.title)}</strong><span>${esc(entries[0]?.ko || '')}${entries.length > 1 ? ` 외 ${entries.length - 1}개 문서` : ''}</span></span>
      <span class="study-chapter-progress">${progress(confirmed, entries.length)}<span>${confirmed} / ${entries.length}<span class="study-sr-only">개 문서 확정</span></span></span>
      <span class="study-chevron" aria-hidden="true">⌄</span>
    </button>
    <div class="study-chapter-docs" id="chapter-${esc(chapter.id)}" hidden>
      ${entries.length ? entries.slice(0, 5).map(doc => `<button data-doc="${esc(doc.id)}" class="study-inline-doc"><span>${esc(doc.title)}</span>${badge(doc)}</button>`).join('') : '<p class="muted">이 권에 아직 문서가 없습니다.</p>'}
      ${entries.length > 5 ? `<button class="study-text-button" data-chapter-filter="${esc(chapter.id)}">이 권의 문서 ${entries.length}개 모두 보기 <span aria-hidden="true">→</span></button>` : ''}
    </div>
  </article>`;
}

const overview = `<div id="study-overview" role="tabpanel" aria-labelledby="study-tab-overview">
  <div class="study-spread">
    <div class="study-main-column">
      <section class="study-progress-section" aria-labelledby="study-progress-title">
        <div class="study-section-heading"><h2 id="study-progress-title">번역의 현재 위치</h2><span class="study-label">전체 ${stats.total}문서</span></div>
        ${stats.total ? `<div class="study-progress-summary"><div><span class="study-percent mono">${percent}<small>%</small></span><span class="study-percent-label">번역 확정</span></div><p><strong>${stats.confirmed}개 문서를 확정했습니다.</strong><span>${stats.total - stats.confirmed}개 문서의 작업이 남아 있습니다.</span></p></div>
          <div class="study-stage-bar" role="img" aria-label="${stages.map(([, label], index) => `${label} ${stageCounts[index]}개`).join(', ')}">${stages.map(([key], index) => stageCounts[index] ? `<span class="stage-${key}" style="flex:${stageCounts[index]}"></span>` : '').join('')}</div>
          <div class="study-stage-legend">${stages.map(([key, label], index) => `<span><i class="stage-${key}"></i>${label}<b class="mono">${stageCounts[index]}</b></span>`).join('')}</div>` : `<div class="study-progress-empty"><h3>첫 원문에서 시작하는 번역</h3><p>문서를 추가하면 번역의 진행과 전체 구성이 이곳에 모입니다.</p><button class="btn primary" data-panel="add">첫 문서 추가</button></div>`}
      </section>
      <section class="study-chapters-section" aria-labelledby="study-chapters-title">
        <div class="study-section-heading"><h2 id="study-chapters-title">문헌의 구성</h2><span class="study-label">${chapters.length}개 묶음 <span class="study-dot">·</span> 확정 / 전체</span></div>
        <div class="study-chapter-list">${chapters.length ? chapters.map(chapterRow).join('') : '<p class="study-empty-copy">원문을 권과 편으로 묶어 문헌의 흐름을 정리해 보세요.</p>'}</div>
        ${chapters.length > 6 ? `<button class="study-text-button study-more-chapters" id="study-all-chapters" aria-expanded="false">나머지 ${chapters.length - 6}개 묶음 펼치기 <span aria-hidden="true">↓</span></button>` : ''}
      </section>
    </div>
    <aside class="study-desk" aria-labelledby="study-desk-title">
      <div class="study-section-heading"><h2 id="study-desk-title">연구의 바탕</h2><span class="study-label">프로젝트 공통</span></div>
      <p class="study-desk-intro">문서가 달라도 함께 이어지는<br>해석의 기준과 참고자료.</p>
      <button class="study-resource" data-panel="context"><span class="study-resource-icon" aria-hidden="true">文</span><span><strong>공통 문맥</strong><small>문헌의 배경과 번역 원칙</small></span>${arrow}</button>
      <button class="study-resource" data-panel="library"><span class="study-resource-icon" aria-hidden="true">冊</span><span><strong>참고자료</strong><small>판본과 대조할 자료 모음</small></span>${arrow}</button>
      <button class="study-resource" data-panel="notes"><span class="study-resource-icon" aria-hidden="true">記</span><span><strong>연구 메모</strong><small>작업하며 남긴 질문과 판단</small></span>${arrow}</button>
      <details class="study-principles" open><summary>작업 중 기억할 것 <span aria-hidden="true">⌄</span></summary><p>관직명과 제도 용어는 원문을 함께 확인합니다. 판단이 어려운 대목은 근거와 의문을 남겨 다시 살핍니다.</p><button data-panel="context" class="study-text-button">공통 문맥 살펴보기 <span aria-hidden="true">→</span></button></details>
      ${stats.review || stats.uncertainties ? `<div class="study-attention"><span class="study-attention-mark" aria-hidden="true"></span><p>${stats.review ? `검토할 문서 <strong>${stats.review}개</strong>` : ''}${stats.review && stats.uncertainties ? '<span class="study-dot">·</span>' : ''}${stats.uncertainties ? `불확실한 대목 <strong>${stats.uncertainties}건</strong>` : ''}</p><button class="study-text-button" id="study-review-docs">문서 살펴보기 <span aria-hidden="true">→</span></button></div>` : ''}
    </aside>
  </div>
  <section class="study-recent-section" aria-labelledby="study-recent-title">
    <div class="study-section-heading"><h2 id="study-recent-title">다시 펼칠 문서</h2><button class="study-text-button" data-show-documents>전체 문서 보기 <span aria-hidden="true">→</span></button></div>
    ${recentDocs.length ? `<div class="study-recent-docs">${recentDocs.map(doc => { const activity = recent.find(item => item.docId === doc.id); return `<button class="study-recent-doc" data-doc="${esc(doc.id)}"><span class="study-recent-meta">${esc(doc.chapter || '')}<span>${esc(activity?.when || doc.updated || '')}</span></span><strong class="serif">${esc(doc.title)}</strong><span class="study-doc-korean">${esc(doc.ko || '')}</span><span class="study-excerpt">${esc(doc.excerpt || doc.translationExcerpt || '')}</span><span class="study-recent-footer">${badge(doc)}<span>${esc(activity?.action || '문서 미리보기')} <span aria-hidden="true">→</span></span></span></button>`; }).join('')}</div>` : '<p class="study-empty-copy">작업한 문서가 생기면 이곳에서 이어서 열 수 있습니다.</p>'}
  </section>
</div>`;

mountShell('03-study', `<main class="study-page">
  <header class="study-project-header">
    <div class="study-project-intro"><p class="eyebrow">프로젝트 서재</p><h1 class="serif">${esc(project.title)}</h1><p class="study-subtitle">${esc(project.subtitle)}</p><p class="study-description">${esc(project.description)}</p></div>
    <div class="study-project-facts"><dl><div><dt>작업 흐름</dt><dd>${esc(project.scope)}</dd></div><div><dt>시대·주제</dt><dd>${esc(project.period)}</dd></div><div><dt>구성</dt><dd>${chapters.length}개 묶음 <span class="study-dot">·</span> ${stats.total}개 문서</dd></div></dl><button class="study-text-button" data-panel="project">프로젝트 정보 ${arrow}</button></div>
  </header>
  <nav class="study-tabs" role="tablist" aria-label="프로젝트 화면"><button role="tab" id="study-tab-overview" aria-controls="study-overview" aria-selected="true" tabindex="0">프로젝트 개요</button><button role="tab" id="study-tab-documents" aria-controls="study-documents" aria-selected="false" tabindex="-1">전체 문서 <span class="mono">${stats.total}</span></button></nav>
  ${overview}
  <section id="study-documents" role="tabpanel" aria-labelledby="study-tab-documents" hidden>
    <div class="study-document-toolbar"><label class="study-search"><span aria-hidden="true">⌕</span><input id="study-search" type="search" placeholder="문서 제목으로 찾기" aria-label="문서 제목으로 찾기"></label><label class="study-filter"><span class="study-sr-only">문서 상태</span><select id="study-stage-filter"><option value="all">모든 상태</option>${stages.map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}<option value="attention">검토와 불확실성</option></select></label><button class="btn" data-panel="add">문서 추가</button></div>
    <div class="study-document-count"><span id="study-result-count" aria-live="polite"></span><button class="study-text-button" id="study-clear-filter" hidden>필터 초기화</button></div>
    <div id="study-document-list"></div>
  </section>
</main>`);

let selectedChapter = '';
const panels = ['overview', 'documents'];
function showPanel(name, focus = false) {
  panels.forEach(panel => {
    const selected = name === panel;
    const tab = document.getElementById(`study-tab-${panel}`);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(`study-${panel}`).hidden = !selected;
    if (selected && focus) tab.focus();
  });
  if (name === 'documents') renderDocuments();
}
function renderDocuments() {
  const query = document.getElementById('study-search').value.trim().toLocaleLowerCase();
  const filter = document.getElementById('study-stage-filter').value;
  const filtered = docs.filter(doc => (!selectedChapter || doc.chapterId === selectedChapter)
    && (!query || `${doc.title} ${doc.ko || ''} ${doc.chapter || ''}`.toLocaleLowerCase().includes(query))
    && (filter === 'all' || (filter === 'attention' ? doc.needsReview || doc.uncertainties : doc.stage === filter)));
  const chapter = chapters.find(item => item.id === selectedChapter);
  document.getElementById('study-result-count').textContent = `${chapter ? `${chapter.title} · ` : ''}${filtered.length}개 문서`;
  document.getElementById('study-clear-filter').hidden = !query && filter === 'all' && !selectedChapter;
  document.getElementById('study-document-list').innerHTML = filtered.length
    ? filtered.map(doc => `<button class="study-document-row" data-doc="${esc(doc.id)}"><span class="study-document-title"><strong>${esc(doc.title)}</strong><small>${esc(doc.ko || '')}</small></span><span class="study-document-chapter">${esc(doc.chapter || '')}</span>${badge(doc)}<span class="study-document-updated">${esc(doc.updated || '')}</span><span aria-hidden="true">↗</span></button>`).join('')
    : `<div class="empty-state"><h3>${docs.length ? '조건에 맞는 문서가 없습니다' : '아직 문서가 없습니다'}</h3><p>${docs.length ? '검색어나 문서 상태를 바꿔 보세요.' : '첫 문서를 추가하고 이 프로젝트의 번역을 시작해 보세요.'}</p>${docs.length ? '<button class="btn" id="study-empty-reset">필터 초기화</button>' : '<button class="btn primary" data-panel="add">문서 추가</button>'}</div>`;
}
function resetFilters() {
  selectedChapter = '';
  document.getElementById('study-search').value = '';
  document.getElementById('study-stage-filter').value = 'all';
  renderDocuments();
}
document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.id === 'study-tab-overview') showPanel('overview');
  if (button.id === 'study-tab-documents' || button.hasAttribute('data-show-documents')) showPanel('documents');
  if (button.hasAttribute('data-toggle-chapter')) {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    document.getElementById(button.getAttribute('aria-controls')).hidden = expanded;
  }
  if (button.id === 'study-all-chapters') {
    const expanded = button.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('[data-extra-chapter]').forEach(row => row.hidden = expanded);
    button.setAttribute('aria-expanded', String(!expanded));
    button.innerHTML = expanded ? `나머지 ${chapters.length - 6}개 묶음 펼치기 <span aria-hidden="true">↓</span>` : '6개 묶음만 보기 <span aria-hidden="true">↑</span>';
  }
  if (button.hasAttribute('data-chapter-filter')) {
    selectedChapter = button.dataset.chapterFilter;
    document.getElementById('study-search').value = '';
    document.getElementById('study-stage-filter').value = 'all';
    showPanel('documents', true);
  }
  if (button.id === 'study-review-docs') {
    selectedChapter = '';
    document.getElementById('study-search').value = '';
    document.getElementById('study-stage-filter').value = 'attention';
    showPanel('documents', true);
  }
  if (['study-clear-filter', 'study-empty-reset'].includes(button.id)) resetFilters();
});
document.querySelector('.study-tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = event.target.id === 'study-tab-overview' ? 'overview' : 'documents';
  const next = event.key === 'Home' ? 'overview' : event.key === 'End' ? 'documents' : current === 'overview' ? 'documents' : 'overview';
  showPanel(next, true);
});
document.getElementById('study-search').addEventListener('input', renderDocuments);
document.getElementById('study-stage-filter').addEventListener('change', renderDocuments);
