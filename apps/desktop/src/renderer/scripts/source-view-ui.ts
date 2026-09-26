import { must } from "./shared";

/** The source sheet's reading-size popover; the size itself is shared (see reading-type). */
export function configureSourceView(): void {
  const settings = must<HTMLElement>("#sourceViewSettings");
  settings.addEventListener("toggle", () => must("#btnSourceView").setAttribute("aria-expanded", String(settings.matches(":popover-open"))));
}
