import { t } from "./i18n";
import { store } from "./shared";

const FONT_SIZES = ["18", "20", "22", "24"];
const LINE_HEIGHTS: [string, string][] = [["1.7", "좁게"], ["2", "보통"], ["2.2", "넓게"]];
const FONT_KEY = "munhae.reading.font-size", LEADING_KEY = "munhae.reading.line-height";
const valid = (value: string | null, allowed: string[]) => value && allowed.includes(value) ? value : null;

let fontSize = "20", lineHeight = "2";
const listeners = new Set<() => void>();

/** One reading size for the hanmun text on every workflow screen. Stored on this device. */
export function configureReadingType(): void {
  // Earlier builds kept one setting per screen; adopt the first one the reader chose.
  const legacyFont = valid(store.get("munhae.source.font-size"), FONT_SIZES) ?? valid(store.get("munhae.punctuation.font-size"), FONT_SIZES)
    ?? (store.get("munhae.reading-size") === "large" ? "22" : null);
  const legacyLeading = valid(store.get("munhae.source.line-height"), ["1.7", "2", "2.2"]) ?? ({ "1.7": "1.7", "1.9": "2", "2.2": "2.2" } as Record<string, string>)[store.get("munhae.punctuation.line-height") ?? ""];
  fontSize = valid(store.get(FONT_KEY), FONT_SIZES) ?? legacyFont ?? fontSize;
  lineHeight = valid(store.get(LEADING_KEY), LINE_HEIGHTS.map(([value]) => value)) ?? legacyLeading ?? lineHeight;
  document.querySelectorAll<HTMLElement>("[data-reading-type-fields]").forEach(host => { host.innerHTML = readingTypeFields(host.dataset.readingTypeFields!); });
  document.addEventListener("change", event => {
    const select = event.target as HTMLSelectElement;
    if (select.matches("[data-reading-font]")) fontSize = select.value;
    else if (select.matches("[data-reading-leading]")) lineHeight = select.value;
    else return;
    store.set(FONT_KEY, fontSize); store.set(LEADING_KEY, lineHeight);
    apply();
  });
  apply();
}

export function onReadingTypeChange(listener: () => void): void { listeners.add(listener); }

/** Field markup for a reading-size popover; `id` keeps label/select pairs unique per screen. */
export function readingTypeFields(id: string): string {
  const option = (value: string, label: string, selected: boolean, i18n = false) => `<option value="${value}"${selected ? " selected" : ""}${i18n ? ` data-i18n="${label}"` : ""}>${i18n ? t(label) : label}</option>`;
  return `<div class="field"><label for="${id}FontSize" data-i18n="글자 크기">${t("글자 크기")}</label><select class="select" id="${id}FontSize" data-reading-font>${FONT_SIZES.map(size => option(size, `${size} px`, size === fontSize)).join("")}</select></div>`
    + `<div class="field"><label for="${id}LineHeight" data-i18n="줄 간격">${t("줄 간격")}</label><select class="select" id="${id}LineHeight" data-reading-leading>${LINE_HEIGHTS.map(([value, label]) => option(value, label, value === lineHeight, true)).join("")}</select></div>`;
}

function apply(): void {
  document.body.style.setProperty("--hanmun-font-size", `${fontSize}px`);
  document.body.style.setProperty("--hanmun-line-height", lineHeight);
  document.querySelectorAll<HTMLSelectElement>("[data-reading-font]").forEach(select => { select.value = fontSize; });
  document.querySelectorAll<HTMLSelectElement>("[data-reading-leading]").forEach(select => { select.value = lineHeight; });
  listeners.forEach(listener => listener());
}
