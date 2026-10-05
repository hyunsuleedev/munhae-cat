import type { AppConfig, MunhaeApi } from "../../shared/munhae-api";
import { EN, translateUi, type UiLanguage } from "../../shared/ui-translations";

let language: UiLanguage = "ko";
export function setUiLanguage(value: UiLanguage): void {
  language = value;
  document.documentElement.lang = value;
}
export function t(text: string): string { return translateUi(text, language); }
/** A label whose English depends on its role, e.g. 용어 naming a list or stage ("용어@plural": "Terms") or 선택 as a step badge ("선택@optional").
 * Reads "<text>@<role>" from the table and falls back to t(text). Korean is unchanged. */
export function tAs(role: string, text: string): string {
  const trimmed = text.trim(), translated = language === "en" ? EN[`${trimmed}@${role}`] : undefined;
  return translated === undefined ? t(text) : text.replace(trimmed, () => translated);
}

/** Translate authored markup only, before inserting user-provided values. */
export function uiText(source: string): string {
  return source.replace(/(^|>)([^<]*)(?=<|$)/g, (_, start: string, text: string) => start + t(text))
    .replace(/\b(title|placeholder|aria-label)="([^"]*)"/g, (_, attr: string, text: string) => `${attr}="${t(text)}"`);
}
/** Interpolations are opaque: documents, names, prompts and HTML-escaped user text stay intact. */
export function ui(parts: TemplateStringsArray, ...values: unknown[]): string {
  const authored = parts.reduce((out, part, i) => out + part + (i < values.length ? `{{${i}}}` : ""), "");
  return uiText(authored).replace(/\{\{(\d+)\}\}/g, (_, index: string) => String(values[Number(index)]));
}
export function translateStaticPage(root: ParentNode = document): void {
  // Only explicitly marked, authored leaf nodes and attributes are translated.
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach(el => { el.textContent = el.dataset.i18nRole ? tAs(el.dataset.i18nRole, el.dataset.i18n!) : t(el.dataset.i18n!); });
  for (const attr of ["title", "placeholder", "aria-label"]) {
    root.querySelectorAll<HTMLElement>(`[data-i18n-${attr}]`).forEach(el => {
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)!));
    });
  }
}
export async function initializeLanguage(api: Pick<MunhaeApi, "app">): Promise<AppConfig> {
  const config = await api.app.getConfig();
  setUiLanguage(config.language ?? "ko");
  translateStaticPage();
  document.querySelectorAll<HTMLSelectElement>("[data-language-picker]").forEach(select => {
    select.value = config.language ?? "ko";
    select.addEventListener("change", async () => {
      select.disabled = true;
      const error = document.querySelector<HTMLElement>("[data-language-error]");
      if (error) error.hidden = true;
      try {
        await api.app.setConfig({ language: select.value === "en" ? "en" : "ko" });
        location.reload();
      } catch {
        select.value = language;
        select.disabled = false;
        if (error) { error.textContent = t("설정을 저장하지 못했습니다."); error.hidden = false; }
      }
    });
  });
  return config;
}
