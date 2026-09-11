import type { AppConfig, MunhaeApi } from "../../shared/munhae-api";

let initialized = false;

/** Each HTML page owns one player; session position survives full-page navigation. */
export function initBackgroundMusic(api: MunhaeApi): void {
  if (initialized) return;
  initialized = true;
  const audio = document.createElement("audio");
  audio.id = "munhaeBackgroundMusic";
  audio.src = new URL("./music/sangnyeongsan-1-2.mp3", location.href).href;
  audio.loop = true;
  audio.volume = 0.18;
  audio.preload = "metadata";
  document.body.append(audio);
  let enabled = false;
  let revision = 0;
  const positionKey = "munhae:background-music-position";
  const status = (text: string) => {
    const el = document.getElementById("backgroundMusicStatus");
    if (el) el.textContent = text;
  };
  const play = async () => {
    if (!enabled) return;
    try {
      await audio.play();
      if (!enabled) audio.pause();
      else status("재생 중");
    } catch (error) {
      if (!enabled) return;
      status(error instanceof DOMException && error.name === "NotAllowedError"
        ? "화면을 클릭하면 음악이 재생됩니다."
        : "음악을 재생하지 못했습니다. 음악을 껐다가 다시 켜 주세요.");
    }
  };
  const apply = (config: AppConfig) => {
    audio.volume = Math.min(100, Math.max(0, config.backgroundMusicVolume ?? 18)) / 100;
    enabled = config.backgroundMusicEnabled;
    if (enabled) void play();
    else { audio.pause(); status("꺼짐"); }
  };
  audio.addEventListener("loadedmetadata", () => {
    try {
      const position = Number(sessionStorage.getItem(positionKey));
      if (Number.isFinite(position) && position > 0 && position < audio.duration) audio.currentTime = position;
    } catch { /* Playback remains available when storage is unavailable. */ }
  }, { once: true });
  audio.addEventListener("error", () => {
    if (enabled) status("음원 파일을 불러오지 못했습니다.");
  });
  window.addEventListener("pagehide", () => {
    try { sessionStorage.setItem(positionKey, String(audio.currentTime)); } catch { /* Best effort. */ }
    audio.pause();
  });
  window.addEventListener("pageshow", () => { if (enabled) void play(); });
  // Browser previews may require a gesture; Electron explicitly allows autoplay.
  for (const event of ["pointerdown", "keydown"]) {
    document.addEventListener(event, () => { if (enabled && audio.paused) void play(); });
  }
  window.addEventListener("munhae:config-changed", (event) => {
    revision++;
    apply((event as CustomEvent<AppConfig>).detail);
  });
  const initialRevision = revision;
  void api.app.getConfig().then((config) => {
    if (revision === initialRevision) apply(config);
  }).catch(() => status("배경음악 설정을 불러오지 못했습니다."));
}
