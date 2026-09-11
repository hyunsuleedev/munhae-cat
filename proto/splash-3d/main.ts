import { createBookScene, type BookScene } from './book';
import { DURATION, WRITING_START, WRITING_END } from './calligraphy';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const host = element<HTMLDivElement>('scene');
const identity = element<HTMLDivElement>('identity');
const timeline = element<HTMLInputElement>('timeline');
const play = element<HTMLButtonElement>('play');
const status = element<HTMLSpanElement>('status');
const splash = element<HTMLElement>('splash');
const welcome = element<HTMLElement>('welcome');
const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
const duration = DURATION;
timeline.max = String(duration);
let seconds = motionQuery.matches ? duration : 0;
let playing = !motionQuery.matches;
let scene: BookScene | undefined;
let frame = 0, lastTime = 0, disposed = false, transitioning = false;
let pointerX = 0, pointerY = 0, smoothX = 0, smoothY = 0;
let transitionTimer = 0;
let detail = 0, detailTarget = 0;

function updateControls() {
  play.setAttribute('aria-label', playing ? '일시정지' : seconds >= duration ? '처음부터 다시 재생' : '재생');
  element<HTMLElement>('play-icon').innerHTML = playing ? '<path d="M9 6v12M15 6v12"/>' : '<path d="m9 5 10 7-10 7Z"/>';
  timeline.value = String(seconds);
  timeline.setAttribute('aria-valuetext', `${seconds.toFixed(1)}초 / ${duration}초`);
  element<HTMLOutputElement>('time').value = `${seconds.toFixed(1)} / ${duration}`;
}

function draw() {
  scene?.render(seconds, smoothX, smoothY, detail);
  const progress = Math.max(0, Math.min(1, (seconds - WRITING_END + .7) / .85));
  const reveal = 1 - (1 - progress) ** 3;
  identity.style.opacity = String(reveal * (1 - detail));
  identity.style.transform = `translateY(${8 * (1 - reveal)}px)`;
  const nextStatus = seconds < WRITING_START ? '문해를 준비하고 있습니다'
    : seconds < WRITING_END ? '한 획씩, 뜻을 펼칩니다' : '옛 글을 읽고, 뜻을 잇다';
  if (status.textContent !== nextStatus) status.textContent = nextStatus;
  updateControls();
}

function tick(now: number) {
  frame = 0;
  if (disposed || document.hidden || transitioning) return;
  const delta = lastTime ? Math.min((now - lastTime) / 1000, .05) : 0;
  lastTime = now;
  if (playing) {
    const speed = Number(element<HTMLSelectElement>('speed').value);
    seconds = Math.min(duration, seconds + delta * speed);
    if (seconds >= duration) playing = false;
  }
  smoothX += (pointerX - smoothX) * .065; smoothY += (pointerY - smoothY) * .065;
  detail += (detailTarget - detail) * .10;
  draw();
  if (playing || Math.abs(pointerX - smoothX) + Math.abs(pointerY - smoothY) + Math.abs(detailTarget - detail) > .002) wake();
}
function wake() { if (!frame && !disposed && !document.hidden && !transitioning) frame = requestAnimationFrame(tick); }
function pause() { playing = false; lastTime = 0; updateControls(); }
function replay() {
  window.clearTimeout(transitionTimer);
  transitioning = false; welcome.hidden = true; splash.hidden = false; splash.classList.remove('is-exiting');
  seconds = motionQuery.matches ? duration : 0; playing = !motionQuery.matches; lastTime = 0;
  draw(); wake();
}

element('replay').addEventListener('click', replay);
element('back').addEventListener('click', replay);
element('detail').addEventListener('click', () => {
  detailTarget = detailTarget ? 0 : 1;
  element('detail').setAttribute('aria-pressed', String(Boolean(detailTarget)));
  element('detail').textContent = detailTarget ? '전체 보기' : '붓글씨 확대';
  if (motionQuery.matches) detail = detailTarget;
  lastTime = 0; draw(); wake();
});
play.addEventListener('click', () => {
  if (transitioning) replay();
  if (motionQuery.matches) { seconds = duration; pause(); draw(); return; }
  if (seconds >= duration) seconds = 0;
  playing = !playing; lastTime = 0; updateControls(); wake();
});
timeline.addEventListener('input', () => {
  const requested = Number(timeline.value);
  if (transitioning) { window.clearTimeout(transitionTimer); transitioning = false; welcome.hidden = true; splash.hidden = false; splash.classList.remove('is-exiting'); }
  pause(); seconds = requested; draw();
});
element('transition').addEventListener('click', () => {
  if (transitioning) return;
  pause(); transitioning = true; splash.classList.add('is-exiting');
  transitionTimer = window.setTimeout(() => {
    splash.hidden = true; welcome.hidden = false;
    element<HTMLButtonElement>('back').focus({ preventScroll: true });
  }, motionQuery.matches ? 0 : 280);
});
host.addEventListener('pointermove', event => {
  if (motionQuery.matches || event.pointerType !== 'mouse') return;
  const rect = host.getBoundingClientRect();
  pointerX = (event.clientX - rect.left) / rect.width * 2 - 1;
  pointerY = (event.clientY - rect.top) / rect.height * 2 - 1;
  wake();
});
host.addEventListener('pointerleave', () => { pointerX = pointerY = 0; wake(); });
document.addEventListener('visibilitychange', () => {
  lastTime = 0;
  if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
  else wake();
});
motionQuery.addEventListener('change', () => {
  if (motionQuery.matches) { seconds = duration; pointerX = pointerY = smoothX = smoothY = 0; pause(); draw(); }
});
function fallback() {
  scene?.dispose(); scene = undefined; host.hidden = true; element('fallback').hidden = false;
  seconds = duration; pause(); draw(); status.textContent = '문해 — 시작 화면 미리보기';
}
host.addEventListener('webglcontextlost', event => { event.preventDefault(); if (!disposed) fallback(); }, true);
window.addEventListener('pagehide', () => {
  disposed = true; cancelAnimationFrame(frame); window.clearTimeout(transitionTimer); scene?.dispose();
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

async function boot() {
  try {
    await document.fonts.ready;
    scene = await createBookScene(host);
    if (disposed) { scene.dispose(); return; }
    draw(); wake();
  } catch (error) {
    console.warn('3D preview unavailable:', error instanceof Error ? error.message : 'WebGL unavailable');
    fallback();
  }
}
void boot();
