import { getDemo, mountShell, badge, progress, esc } from './shared.js';

const demo = getDemo();
const { project, docs, chapters, stats, recent, issues } = demo;
const recentDoc = docs.find(doc => doc.id === recent[0]?.docId);
const resume = recentDoc || docs.find(doc => !doc.confirmed) || docs[0];
const chapterDocs = chapter => Array.isArray(chapter.docs) ? chapter.docs : docs.filter(doc => doc.chapterId === chapter.id);
const openChapters = new Set(demo.scenario === 'single' ? chapters.map(chapter => chapter.id) : []);
let query = '';
let stage = 'all';
let renderedChapters = [];

const arrow = '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const searchIcon = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

function statsStrip() {
  const stages = [['원문 정리', stats.source], ['표점 작성', stats.punctuation], ['번역안 작성', stats.translation], ['번역 확정', stats.confirmed]];
  return `<div class="atlas-stats" aria-label="프로젝트 단계별 진행 현황">${stages.map(([label, count]) => `<div class="atlas-stat"><span>${label}</span><div><strong>${count}</strong><span class="atlas-stat-total">/ ${stats.total}</span></div>${progress(count, stats.total).replace('aria-label="번역 확정"', `aria-label="${label}"`).replace(`aria-valuetext="${count}/${stats.total}건 확정"`, `aria-valuetext="${stats.total}건 중 ${count}건 ${label}"`)}</div>`).join('')}</div>`;
}

function resumeBlock() {
  if (!resume) return `<section class="atlas-resume"><span class="eyebrow">첫 작업</span><h2>원문부터 시작하세요</h2><p>문헌의 목차를 만들고, 첫 원문을 담아 보세요.</p><button class="btn primary" data-panel="add">원문 추가 ${arrow}</button></section>`;
  const action = resume.needsReview ? '번역 검토하기' : resume.confirmed ? '문서 다시 열기' : '이어서 작업하기';
  return `<section class="atlas-resume" aria-labelledby="resume-heading"><div class="atlas-aside-kicker"><span class="eyebrow">${recentDoc ? '최근 작업한 문서' : '다음 작업'}</span><span class="atlas-tiny-dot" aria-hidden="true"></span></div><h2 id="resume-heading">${esc(resume.title)}</h2><p class="atlas-resume-location">${esc(resume.chapter)} · ${esc(resume.ko)}</p><p class="atlas-excerpt">${esc(resume.excerpt)}</p><div class="atlas-resume-status">${badge(resume)}<span>${esc(resume.updated)}</span></div><button class="btn primary atlas-resume-button" data-doc="${esc(resume.id)}">${action} ${arrow}</button></section>`;
}

function issuesBlock() {
  return `<section class="atlas-aside-section" aria-labelledby="issues-heading"><div class="atlas-aside-heading"><h2 id="issues-heading">살펴볼 구절</h2><span>${stats.uncertainties}건</span></div>${issues.length ? `<div class="atlas-issues">${issues.slice(0, 3).map(issue => `<button class="atlas-issue" data-doc="${esc(issue.docId)}"><span class="atlas-issue-mark" aria-hidden="true"></span><span><strong>${esc(issue.title)}</strong><span>${esc(issue.body)}</span></span>${arrow}</button>`).join('')}</div>` : '<p class="atlas-quiet">아직 남겨 둔 불확실성이 없습니다.</p>'}<button class="atlas-text-link" data-panel="notes">연구 노트 살펴보기 ${arrow}</button></section>`;
}

function recentBlock() {
  return `<section class="atlas-aside-section" aria-labelledby="recent-heading"><div class="atlas-aside-heading"><h2 id="recent-heading">최근 바뀐 내용</h2></div>${recent.length ? `<ol class="atlas-recent">${recent.slice(0, 3).map(item => `<li><span class="atlas-recent-dot" aria-hidden="true"></span><button data-doc="${esc(item.docId)}"><strong>${esc(item.title)}</strong><span>${esc(item.action)}</span><time>${esc(item.when)}</time></button></li>`).join('')}</ol>` : '<p class="atlas-quiet">작업을 시작하면 이곳에 기록됩니다.</p>'}</section>`;
}

mountShell('01-atlas', `<main class="atlas-main">
  <header class="atlas-project">
    <div class="atlas-project-top"><span class="eyebrow">문헌 지도</span><button class="atlas-text-link" data-panel="project">프로젝트 정보 ${arrow}</button></div>
    <div class="atlas-project-title"><h1>${esc(project.title)}</h1><span>${esc(project.subtitle)}</span></div>
    <p class="atlas-description">${esc(project.description)}</p>
    <div class="atlas-project-meta"><span>${esc(project.period)}</span><span>${esc(project.scope)}</span><button data-panel="context">번역 원칙과 공통 지식 ${arrow}</button></div>
    ${statsStrip()}
  </header>
  <div class="atlas-layout">
    <section class="atlas-contents" aria-labelledby="contents-heading">
      <div class="atlas-contents-heading"><div><span class="eyebrow">CONTENTS</span><h2 id="contents-heading">문헌 목차 <span>${chapters.length}개 장 · ${stats.total}개 원문</span></h2></div><button class="atlas-text-link" data-panel="add">원문 추가 <span aria-hidden="true">＋</span></button></div>
      <div class="atlas-toolbar">
        <div class="atlas-stage-filters" role="group" aria-label="문서 진행 상태"><button data-stage="all" aria-pressed="true">전체 <span>${stats.total}</span></button><button data-stage="review" aria-pressed="false">검토 필요 <span>${stats.review}</span></button><button data-stage="confirmed" aria-pressed="false">확정 <span>${stats.confirmed}</span></button></div>
        <label class="atlas-search">${searchIcon}<input id="atlas-search" type="search" placeholder="목차·문서 검색" aria-label="목차 또는 문서 검색"></label>
      </div>
      <div class="atlas-list-meta"><span id="atlas-result-count" role="status" aria-live="polite"></span><button id="atlas-expand" class="atlas-text-link" type="button">모두 접기</button></div>
      <div id="atlas-chapters"></div>
      <div class="atlas-contents-foot"><span>원문에서 번역까지, 목차를 따라 이어집니다.</span><button class="atlas-text-link" data-panel="library">연결된 자료 ${arrow}</button></div>
    </section>
    <aside class="atlas-aside" aria-label="다음 작업과 최근 기록">${resumeBlock()}${issuesBlock()}${recentBlock()}</aside>
  </div>
</main>`);

function matches(doc) {
  const searchable = `${doc.title} ${doc.ko} ${doc.chapter}`.toLocaleLowerCase();
  return (!query || searchable.includes(query)) && (stage === 'all' || (stage === 'review' ? doc.needsReview : doc.confirmed));
}

function updateExpandLabel() {
  const button = document.querySelector('#atlas-expand');
  button.hidden = renderedChapters.length === 0;
  button.textContent = renderedChapters.every(chapter => openChapters.has(chapter.id)) ? '모두 접기' : '모두 펼치기';
}

function renderContents() {
  const filtered = chapters.map(chapter => ({ ...chapter, visibleDocs: chapterDocs(chapter).filter(matches) })).filter(chapter => chapter.visibleDocs.length);
  renderedChapters = filtered;
  const count = filtered.reduce((total, chapter) => total + chapter.visibleDocs.length, 0);
  document.querySelector('#atlas-result-count').textContent = query || stage !== 'all' ? `${stats.total}개 중 ${count}개 문서` : '장별 번역 확정 현황';
  document.querySelector('#atlas-chapters').innerHTML = filtered.length ? filtered.map(chapter => {
    const allDocs = chapterDocs(chapter);
    const confirmed = allDocs.filter(doc => doc.confirmed).length;
    const chapterIndex = chapters.findIndex(item => item.id === chapter.id) + 1;
    return `<details class="atlas-chapter" data-chapter="${esc(chapter.id)}" ${openChapters.has(chapter.id) ? 'open' : ''}>
      <summary><span class="atlas-disclosure" aria-hidden="true"></span><span class="atlas-chapter-index">${String(chapterIndex).padStart(2, '0')}</span><span class="atlas-chapter-title"><strong>${esc(chapter.title.replace(/^\d+\s*[·.．]\s*/, ''))}</strong><span>${allDocs.length}개 원문${allDocs.some(doc => doc.needsReview) ? ` · 검토 필요 ${allDocs.filter(doc => doc.needsReview).length}` : ''}</span></span><span class="atlas-chapter-progress"><span><b>${confirmed}</b> / ${allDocs.length} 확정</span>${progress(confirmed, allDocs.length)}</span></summary>
      <div class="atlas-doc-list">${chapter.visibleDocs.map(doc => `<div class="atlas-doc-row"><span class="atlas-doc-index">${String(allDocs.indexOf(doc) + 1).padStart(2, '0')}</span><button class="atlas-doc-title" data-doc="${esc(doc.id)}"><strong>${esc(doc.title)}</strong><span>${esc(doc.ko)}</span></button><span class="atlas-doc-stage">${badge(doc)}</span><button class="atlas-doc-open" data-doc="${esc(doc.id)}" aria-label="${esc(doc.title)} 열기">${arrow}</button></div>`).join('')}</div>
    </details>`;
  }).join('') : `<div class="empty-state atlas-empty"><span class="atlas-empty-glyph" aria-hidden="true">冊</span><h3>${docs.length ? '조건에 맞는 문서가 없습니다' : '아직 펼칠 원문이 없습니다'}</h3><p>${docs.length ? '다른 문서명으로 검색하거나 상태 필터를 바꿔 보세요.' : '첫 원문을 추가하면 문헌의 목차와 작업 흐름이 이곳에 나타납니다.'}</p>${docs.length ? '<button class="btn" id="atlas-reset">검색과 필터 초기화</button>' : '<button class="btn primary" data-panel="add">첫 원문 추가</button>'}</div>`;
  document.querySelectorAll('[data-stage]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.stage === stage)));
  updateExpandLabel();
}

document.querySelector('#atlas-search').addEventListener('input', event => {
  query = event.target.value.trim().toLocaleLowerCase();
  chapters.forEach(chapter => openChapters.add(chapter.id));
  renderContents();
});

document.addEventListener('click', event => {
  const filter = event.target.closest('[data-stage]');
  if (filter) {
    stage = filter.dataset.stage;
    chapters.forEach(chapter => openChapters.add(chapter.id));
    renderContents();
  }
  if (event.target.closest('#atlas-reset')) {
    stage = 'all';
    query = '';
    document.querySelector('#atlas-search').value = '';
    renderContents();
    document.querySelector('#atlas-search').focus();
  }
  if (event.target.closest('#atlas-expand')) {
    const shouldOpen = !renderedChapters.every(chapter => openChapters.has(chapter.id));
    renderedChapters.forEach(chapter => shouldOpen ? openChapters.add(chapter.id) : openChapters.delete(chapter.id));
    renderContents();
  }
});

document.querySelector('#atlas-chapters').addEventListener('toggle', event => {
  const detail = event.target;
  if (!detail.matches('details[data-chapter]') || !detail.isConnected) return;
  if (detail.open) openChapters.add(detail.dataset.chapter);
  else openChapters.delete(detail.dataset.chapter);
  updateExpandLabel();
}, true);

renderContents();
