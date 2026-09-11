const directions={
  '01-atlas':{title:'01 · 문헌 지도',description:'목차를 중심에 놓고, 프로젝트 진행과 다음 작업을 연결합니다.'},
  '02-desk':{title:'02 · 오늘의 책상',description:'하던 번역으로 돌아오고, 지금 검토할 문서를 찾습니다.'},
  '03-study':{title:'03 · 연구 서재',description:'연구의 배경과 범위, 전체 진행 상황을 한눈에 살펴봅니다.'}
};
const query=new URLSearchParams(location.search);
let view=directions[query.get('view')]?query.get('view'):'01-atlas';
let scenario=['single','full','large','empty'].includes(query.get('scenario'))?query.get('scenario'):'full';
const frame=document.getElementById('preview-frame');
const stage=document.querySelector('.preview-stage');
const wrap=document.querySelector('.frame-size');
const viewport=document.getElementById('viewport');
if(['fit','1440','1024','768','390'].includes(query.get('width')))viewport.value=query.get('width');
function setUrl(){const p=new URLSearchParams({view,scenario,width:viewport.value});history.replaceState(null,'',`${location.pathname}?${p}`);}
function fit(){
  const style=getComputedStyle(stage);
  const available=Math.max(240,stage.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
  const target=viewport.value==='fit'?available:Number(viewport.value);
  const scale=Math.min(1,available/target);
  const height=880;
  frame.style.width=`${target}px`;frame.style.height=`${height}px`;frame.style.transform=`scale(${scale})`;
  wrap.style.width=`${target*scale}px`;wrap.style.height=`${height*scale}px`;
  document.getElementById('frame-dimensions').textContent=`${Math.round(target)} × ${height}${scale<.995?` · ${Math.round(scale*100)}% 축소`:''}`;
}
function render(){
  for(const button of document.querySelectorAll('[data-view]')){const selected=button.dataset.view===view;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;}
  for(const button of document.querySelectorAll('[data-scenario]'))button.setAttribute('aria-pressed',String(button.dataset.scenario===scenario));
  document.getElementById('current-title').textContent=directions[view].title;
  document.getElementById('current-description').textContent=directions[view].description;
  document.getElementById('live-study').setAttribute('aria-labelledby',`tab-${view}`);
  const src=`./${view}.html?scenario=${scenario}`;frame.src=src;frame.title=`${directions[view].title} 시안 · 인터랙티브 미리보기`;
  document.getElementById('standalone').href=src;setUrl();fit();
}
document.querySelector('.direction-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(b&&b.dataset.view!==view){view=b.dataset.view;render();}});
document.querySelector('.direction-tabs').addEventListener('keydown',e=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();const keys=Object.keys(directions),i=keys.indexOf(view);
  view=e.key==='Home'?keys[0]:e.key==='End'?keys.at(-1):keys[(i+(e.key==='ArrowRight'?1:-1)+keys.length)%keys.length];render();document.getElementById(`tab-${view}`).focus();
});
document.querySelector('.scenario-controls').addEventListener('click',e=>{const b=e.target.closest('[data-scenario]');if(b&&b.dataset.scenario!==scenario){scenario=b.dataset.scenario;render();}});
viewport.addEventListener('change',()=>{setUrl();fit();});new ResizeObserver(fit).observe(stage);render();
