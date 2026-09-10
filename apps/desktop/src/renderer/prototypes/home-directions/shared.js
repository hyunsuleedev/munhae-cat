export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {source:'원문 준비',punctuation:'표점 중',draft:'번역안',review:'검토 필요',confirmed:'번역 확정'};
const titles = [
  ['太常寺 卽奉常寺','태상시, 곧 봉상시','review'],['宗廟署','종묘서','confirmed'],['社稷署','사직서','confirmed'],['典牲署','전생서','punctuation'],
  ['典祀','제사를 맡는 일','confirmed'],['祭器','제사에 쓰는 기물','draft'],['祭服','제례의 복식','source'],['樂章','제례의 악장','draft'],
  ['議謚','시호의 논의','review'],['進宴','진연의 절차','confirmed'],['小史','소사의 직무','punctuation'],['讀誄','뇌문을 읽는 일','source']
];
const chapterNames = ['관제와 직무','제례와 의식','용어와 고증'];
export function getDemo() {
  const allowed = ['single','full','large','empty'];
  const query = new URLSearchParams(location.search).get('scenario');
  const scenario = allowed.includes(query) ? query : 'full';
  const count = {single:1,full:12,large:80,empty:0}[scenario];
  const docs = Array.from({length:count}, (_,i) => {
    const [title,ko,stage] = titles[i % 12];
    const group = Math.floor(i/4);
    return {id:`d${i+1}`,title:i<12?title:`${title} · 補 ${Math.floor(i/12)+1}`,ko,
      chapterId:`c${group+1}`,chapter:`${String(group+1).padStart(2,'0')} · ${chapterNames[group%3]}`,
      stage,stageLabel:labels[stage],source:true,punctuation:stage!=='source',translation:['draft','review','confirmed'].includes(stage),confirmed:stage==='confirmed',needsReview:stage==='review',
      uncertainties:stage==='review'?(i===0?2:1):0,updated:i===0?'오늘 14:32':i<4?'어제':`${9-Math.min(i,7)}일 전`,
      excerpt:i===0?'臣謹案，國朝祭禮，專任太常。況議謚、進宴，所掌皆係尊重。':'원문을 검토하고 문맥을 정리하는 예시 문서입니다. 문서 선택과 레이아웃 비교를 위해 구성했습니다.',
      translationExcerpt:i===0?'신이 삼가 살펴보건대, 우리 왕조의 제례는 오로지 태상에 맡겨져 있습니다. 더구나 시호를 의논하고 잔치를 올리는 일까지, 관장하는 일은 모두 존엄하고 중대합니다.':'이곳에 선택한 문서의 번역 일부가 표시됩니다. 실제 사료의 번역이 아닌 화면 비교용 예시입니다.'};
  });
  const chapters = [...new Set(docs.map(d=>d.chapterId))].map(id=>{
    const group=docs.filter(d=>d.chapterId===id);
    return {id,title:group[0].chapter,subtitle:chapterNames[(Number(id.slice(1))-1)%3],docs:group,confirmed:group.filter(d=>d.confirmed).length};
  });
  const stats={total:docs.length,source:docs.filter(d=>d.source).length,punctuation:docs.filter(d=>d.punctuation).length,translation:docs.filter(d=>d.translation).length,confirmed:docs.filter(d=>d.confirmed).length,review:docs.filter(d=>d.needsReview).length,uncertainties:docs.reduce((sum,d)=>sum+d.uncertainties,0)};
  return {scenario,project:{title:'태상시 번역 연구',subtitle:'조선의 관제와 제례를 읽는 번역 프로젝트',description:'관청의 구성과 직무, 제례에 관한 문헌을 함께 읽습니다. 원문의 논리를 보존하고, 제도와 용어의 근거를 정리하며 번역을 완성합니다.',period:'조선 · 관제와 제례',scope:'원문 정리 → 표점 → 번역 → 검토'},docs,chapters,stats,
    recent:docs.slice(0,3).map((d,i)=>({docId:d.id,title:d.title,action:i===0?'번역안에 검토 메모를 남겼습니다.':i===1?'번역을 확정했습니다.':'표점과 번역을 대조했습니다.',when:d.updated})),
    issues:docs.filter(d=>d.needsReview).flatMap(d=>Array.from({length:d.uncertainties},(_,i)=>({docId:d.id,title:d.id==='d1'?(i===0?'「有庶名者」의 번역 검토':'「玉堂」의 용례 확인'):'용어의 출전 확인',body:d.id==='d1'?(i===0?'신분을 나타내는 표현이 원문의 취지를 충분히 살리는지 확인합니다.':'관직과 기관을 가리키는 용례를 참고 자료와 대조합니다.'):`${d.ko}에 사용한 용어와 참고 문헌을 대조합니다.`}))).slice(0,3)};
}
export function badge(doc) {return `<span class="tag stage-${esc(doc.stage)}">${esc(doc.stageLabel)}</span>`;}
export function progress(done,total) {return `<span class="progress-meter" role="progressbar" aria-label="번역 확정" aria-valuemin="0" aria-valuemax="${Math.max(total,1)}" aria-valuenow="${done}" aria-valuetext="${done}/${total}건 확정"><i style="width:${total?Math.round(done/total*100):0}%"></i></span>`;}
export function docButton(doc,label='미리보기',className='btn') {return `<button class="${esc(className)}" data-doc="${esc(doc.id)}">${esc(label)}</button>`;}
const icons={home:'<path d="m3 10 7-6 7 6v8h-5v-5H8v5H3Z"/>',book:'<path d="M10 5v13M3 4h4l3 2 3-2h4v12h-4l-3 2-3-2H3Z"/>',layers:'<path d="m3 7 7-4 7 4-7 4Zm0 5 7 4 7-4M3 16l7 4 7-4"/>',note:'<rect x="4" y="3" width="12" height="15" rx="2"/><path d="M7 7h6M7 10h6M7 13h4"/>',arrow:'<path d="M4 10h12m-5-5 5 5-5 5"/>',settings:'<circle cx="10" cy="10" r="3"/><path d="M10 2v3m0 10v3M2 10h3m10 0h3M4 4l2 2m8 8 2 2M4 16l2-2M14 6l2-2"/>'};
export function icon(name) {return `<svg width="18" height="18" viewBox="0 0 20 22" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||icons.note}</svg>`;}
export function mountShell(designId,html) {
  const demo=getDemo();
  document.body.innerHTML=`<div class="app-shell"><aside class="app-sidebar" aria-label="프로젝트 탐색"><a class="brand" href="./index.html"><span class="brand-mark">文解</span><span>MUNHAE<br>STUDIO</span></a><div class="sidebar-project"><span class="eyebrow">내 프로젝트</span><strong>${esc(demo.project.title)}</strong><small>관제 · 제례 · 번역</small></div><nav class="side-nav"><button class="nav-item active" data-home aria-current="page">${icon('home')}<span>프로젝트 홈</span></button><button class="nav-item" data-panel="project">${icon('book')}<span>전체 문서</span><small>${demo.stats.total}</small></button><button class="nav-item" data-panel="context">${icon('layers')}<span>공통 문맥</span></button><button class="nav-item" data-panel="library">${icon('book')}<span>참고 자료</span></button><button class="nav-item" data-panel="notes">${icon('note')}<span>연구 메모</span></button></nav><div class="sidebar-bottom"><span class="saved-dot"></span>이 기기의 프로젝트<button class="nav-item" data-panel="project">${icon('settings')}<span>프로젝트 정보</span></button></div></aside><div class="app-body"><header class="app-topbar"><span class="topbar-location">프로젝트 <span>/</span> <strong>홈</strong></span><div class="topbar-right"><span class="example-label">예시 데이터</span><a href="./index.html?view=${esc(designId)}&scenario=${demo.scenario}" target="_top">시안 비교 ↗</a></div></header><div class="page-content">${html}</div></div></div><dialog class="demo-dialog" aria-labelledby="dialog-title"><div class="dialog-heading"><span class="eyebrow">문해 · 프로젝트 미리보기</span><button class="icon-btn" data-close aria-label="미리보기 닫기">×</button></div><div id="dialog-content"></div><div class="dialog-footer"><span>레이아웃 검토용 예시 · 변경사항은 저장되지 않습니다.</span><button class="btn" data-close>닫기</button></div></dialog>`;
  const dialog=document.querySelector('.demo-dialog');
  let trigger=null;
  function show(content,element) {if(!dialog.open)trigger=element;document.getElementById('dialog-content').innerHTML=content;if(!dialog.open)dialog.showModal();}
  function close(){dialog.close();trigger?.focus();}
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();}});
  dialog.addEventListener('close',()=>trigger?.focus());
  document.addEventListener('click',e=>{
    const closeBtn=e.target.closest('[data-close]');if(closeBtn){close();return;}
    if(e.target.closest('[data-home]')){window.scrollTo({top:0,behavior:'instant'});return;}
    const docEl=e.target.closest('[data-doc]');
    if(docEl){const d=demo.docs.find(x=>x.id===docEl.dataset.doc);if(!d)return;show(`<p class="muted">${esc(d.chapter)}</p><h2 id="dialog-title" class="serif">${esc(d.title)}</h2><div class="dialog-meta">${badge(d)}<span>${esc(d.ko)} · ${esc(d.updated)}</span></div><h3>원문</h3><p class="source-excerpt">${esc(d.excerpt)}</p><h3>번역</h3><p>${esc(d.translationExcerpt)}</p><div class="research-note"><strong>검토 메모</strong><p>${d.needsReview?'본문의 표현과 번역을 대조하고, 불확실한 용어의 근거를 확인합니다.':'이 문서에 남겨진 검토 요청이 없습니다.'}</p></div>`,docEl);return;}
    const panel=e.target.closest('[data-panel]');if(!panel)return;
    const kind=panel.dataset.panel;
    const content={
      context:`<h2 id="dialog-title">공통 문맥</h2><p class="muted">문서 전체에 참고할 연구 배경과 번역 원칙</p><h3>프로젝트의 관심</h3><p>제례와 관제에 관한 서술에서 제도의 설명과 저자의 비판을 구별합니다. 관직의 명칭은 원문과 함께 기록합니다.</p><h3>번역 원칙</h3><p>논지와 문장 간 관계를 보존합니다. 해석이 갈리는 표현은 근거와 함께 메모하고, 확정되지 않은 사항을 단정하지 않습니다.</p>`,
      library:`<h2 id="dialog-title">참고 자료</h2><p class="muted">자료 구성 예시 · 출전과 판본은 실제 작업에서 확인합니다.</p><ul class="resource-list"><li><strong>『주례』 관련 구절</strong><span>소사의 직무 · 인용 대조</span></li><li><strong>관직명 대조 노트</strong><span>태상·봉상시·옥당의 용례 정리</span></li><li><strong>번역 검토 원칙</strong><span>인명·관직·제도 용어의 표기</span></li></ul>`,
      notes:`<h2 id="dialog-title">연구 메모</h2>${demo.issues.length?demo.issues.map(x=>`<article class="research-note"><h3>${esc(x.title)}</h3><p>${esc(x.body)}</p><button class="btn" data-doc="${esc(x.docId)}">관련 문서 보기 →</button></article>`).join(''):'<p class="empty-state">아직 기록한 연구 메모가 없습니다.</p>'}`,
      project:`<h2 id="dialog-title">${esc(demo.project.title)}</h2><p>${esc(demo.project.description)}</p><p class="muted">원문 ${demo.stats.total}개 · 번역 확정 ${demo.stats.confirmed}개</p><div class="dialog-docs">${demo.docs.length?demo.docs.map(d=>`<button data-doc="${esc(d.id)}"><span class="serif">${esc(d.title)}</span>${badge(d)}</button>`).join(''):'<p>아직 문서가 없습니다. 먼저 작업할 문헌과 목차를 정해 보세요.</p>'}</div>`,
      add:`<h2 id="dialog-title">첫 문서를 준비해 보세요</h2><p>번역할 문헌을 정하고 목차 아래에 원문을 추가하면 작업을 시작할 수 있습니다.</p><div class="research-note"><strong>이 화면에서 레이아웃을 먼저 살펴보세요.</strong><p>비교 화면의 ‘문서 1개’ 또는 ‘문서 12개’를 선택하면 문서가 있는 홈 화면을 볼 수 있습니다.</p></div><a class="btn primary" href="./${esc(designId)}.html?scenario=single">문서 1개 예시 보기 →</a>`
    };
    show(content[kind]||content.project,panel);
  });
}
