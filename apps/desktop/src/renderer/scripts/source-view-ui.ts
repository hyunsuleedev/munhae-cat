import { must, store } from "./shared";

const FONT_SIZES = ["18", "20", "22", "24"];
const LINE_HEIGHTS = ["1.7", "2", "2.2"];

/** Reading size for the source sheet. Stored on this device, separate from punctuation. */
export function configureSourceView(): void {
  const workspace = must<HTMLElement>("#sourceWorkspace");
  const settings = must<HTMLElement>("#sourceViewSettings");
  const font = must<HTMLSelectElement>("#sourceFontSize");
  const leading = must<HTMLSelectElement>("#sourceLineHeight");
  const savedFont = store.get("munhae.source.font-size");
  const savedLeading = store.get("munhae.source.line-height");
  font.value = savedFont && FONT_SIZES.includes(savedFont) ? savedFont : "20";
  leading.value = savedLeading && LINE_HEIGHTS.includes(savedLeading) ? savedLeading : "2";
  const apply = () => {
    workspace.style.setProperty("--source-font-size", `${font.value}px`);
    workspace.style.setProperty("--source-line-height", leading.value);
  };
  font.addEventListener("change", () => { apply(); store.set("munhae.source.font-size", font.value); });
  leading.addEventListener("change", () => { apply(); store.set("munhae.source.line-height", leading.value); });
  settings.addEventListener("toggle", () => must("#btnSourceView").setAttribute("aria-expanded", String(settings.matches(":popover-open"))));
  apply();
}
