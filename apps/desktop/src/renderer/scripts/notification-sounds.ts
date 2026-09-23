import { t } from "./i18n";
import type { AppConfig, MunhaeApi } from "../../shared/munhae-api";
import { completionCue } from "./notification-sound-model";

let initialized = false;
let preview: ((kind: "chat" | "stage") => void) | undefined;
export function previewNotificationSound(kind: "chat" | "stage"): void { preview?.(kind); }

export function initNotificationSounds(api: MunhaeApi): void {
  if (initialized) return;
  initialized = true;
  let enabled = false;
  let volume = 0.35;
  let revision = 0;
  let disposed = false;
  const players = new Set<HTMLAudioElement>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const key = "munhae:heard-completions";
  let heard = new Set<string>();
  try { heard = new Set(JSON.parse(sessionStorage.getItem(key) ?? "[]") as string[]); } catch { /* Session storage is optional. */ }
  const stop = () => {
    timers.forEach(clearTimeout); timers.clear();
    players.forEach(a => { a.pause(); a.remove(); }); players.clear();
  };
  const note = () => {
    if (disposed || volume === 0) return;
    const audio = document.createElement("audio");
    audio.dataset.notificationSound = "true";
    audio.src = new URL("./music/gayageum-notification.wav", location.href).href;
    audio.volume = volume;
    players.add(audio); document.body.append(audio);
    const clean = () => { players.delete(audio); audio.remove(); };
    audio.addEventListener("ended", clean, { once: true });
    audio.addEventListener("error", clean, { once: true });
    void audio.play().catch(() => {
      clean();
      const status = document.getElementById("notificationSoundStatus");
      if (status) status.textContent = t("알림음을 재생하지 못했습니다. 미리듣기를 다시 눌러 주세요.");
    });
  };
  const play = (kind: "chat" | "stage") => {
    stop(); note();
    if (kind === "stage" && volume > 0) {
      const timer = setTimeout(() => { timers.delete(timer); note(); }, 240);
      timers.add(timer);
    }
  };
  preview = play; // Explicit preview works even when automatic alerts are off.
  const apply = (config: AppConfig) => {
    enabled = config.notificationSoundEnabled;
    volume = (config.notificationSoundVolume ?? 35) / 100;
    players.forEach(a => { a.volume = volume; });
    if (!enabled || volume === 0) stop();
  };
  window.addEventListener("munhae:config-changed", event => {
    revision++; apply((event as CustomEvent<AppConfig>).detail);
  });
  const initialRevision = revision;
  const ready = api.app.getConfig().then(config => { if (revision === initialRevision) apply(config); }).catch(() => undefined);
  const unsubscribe = api.ai.onEvent(run => {
    const cue = completionCue(run);
    if (!cue || heard.has(cue.id)) return;
    heard.add(cue.id);
    heard = new Set([...heard].slice(-256));
    try { sessionStorage.setItem(key, JSON.stringify([...heard])); } catch { /* Best effort. */ }
    void ready.then(() => { if (!disposed && enabled) play(cue.kind); });
  });
  window.addEventListener("pagehide", () => { disposed = true; unsubscribe(); stop(); });
}
