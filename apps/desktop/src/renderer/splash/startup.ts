import type { BookScene } from "./book";
import { DURATION, WRITING_END } from "./calligraphy";

const host = document.getElementById("splashScene")!;
const fallback = document.getElementById("splashFallback")!;
const identity = document.getElementById("splashIdentity")!;
const root = document.getElementById("startup")!;
const message = document.getElementById("splashStatus")!;
const continueButton = document.getElementById("splashContinue") as HTMLButtonElement;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let scene: BookScene | undefined;
let frame = 0;
let elapsed = reducedMotion.matches ? DURATION : 0;
let last = 0;
let finished = false;
let ready = false;
let disposed = false;
let leaving = false;
let exitTimer: ReturnType<typeof setTimeout> | undefined;

function disposeScene() {
  cancelAnimationFrame(frame); frame = 0;
  const previous = scene; scene = undefined;
  previous?.dispose();
}

function draw() {
  scene?.render(elapsed);
  const progress = Math.max(0, Math.min(1, (elapsed - WRITING_END + .7) / .85));
  const reveal = scene ? 1 - (1 - progress) ** 3 : 1;
  identity.style.opacity = String(reveal);
  identity.style.transform = `translateY(${8 * (1 - reveal)}px)`;
}

function tick(now: number) {
  frame = 0;
  if (disposed || leaving || document.hidden) return;
  if (last) elapsed = Math.min(DURATION, elapsed + Math.min((now - last) / 1000, .08));
  last = now;
  draw();
  finished = elapsed >= DURATION;
  if (!finished) frame = requestAnimationFrame(tick);
  else void enter();
}

function showFallback() {
  disposeScene();
  host.hidden = true; fallback.hidden = false;
  finished = true; elapsed = DURATION;
  draw();
}

async function enter() {
  if (!ready || !finished || leaving || disposed) return;
  leaving = true; continueButton.disabled = true;
  root.classList.add("is-exiting");
  cancelAnimationFrame(frame);
  exitTimer = setTimeout(() => {
    disposeScene();
    void window.munhaeStartup?.enter().catch(() => {
      if (disposed) return;
      leaving = false; continueButton.disabled = false;
      continueButton.hidden = false;
      root.classList.remove("is-exiting");
      showFallback();
      message.textContent = "화면을 열지 못했습니다. 다시 시작해 주세요.";
    });
  }, reducedMotion.matches ? 0 : 220);
}

continueButton.addEventListener("click", () => { void enter(); });
document.addEventListener("visibilitychange", () => {
  last = 0;
  if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
  else if (scene && !finished && !leaving) frame = requestAnimationFrame(tick);
});
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    elapsed = DURATION; finished = true; cancelAnimationFrame(frame); frame = 0; draw();
    void enter();
  }
});
host.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  if (!disposed && !leaving) { showFallback(); void enter(); }
}, true);
window.addEventListener("pagehide", () => {
  disposed = true; clearTimeout(exitTimer); disposeScene();
});

async function loadScene() {
  if (reducedMotion.matches) { showFallback(); void enter(); return; }
  try {
    const { createBookScene } = await import("./book");
    if (disposed || leaving) return;
    scene = await createBookScene(host);
    if (disposed || leaving) { disposeScene(); return; }
    fallback.hidden = true; draw();
    frame = requestAnimationFrame(tick);
  } catch {
    if (!disposed && !leaving) { showFallback(); void enter(); }
  }
}

void loadScene();
void (async () => {
  try {
    const api = window.munhaeStartup;
    if (!api) throw new Error("startup bridge unavailable");
    const result = await api.wait();
    if (disposed) return;
    if (!result.ok) {
      message.textContent = result.message; showFallback(); return;
    }
    ready = true;
    message.textContent = "준비가 끝났습니다";
    await enter();
  } catch {
    if (disposed) return;
    showFallback();
    message.textContent = "문해를 시작하지 못했습니다. 앱을 다시 열어 주세요.";
  }
})();
