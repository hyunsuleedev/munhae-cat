import content from "../partials/account-content.html?raw";
import { must } from "./shared";
import { translateStaticPage } from "./i18n";

/** Shared form for the sign-in entry and Settings > Account. */
export function renderAccountContent(): void {
  must("#accountContent").innerHTML = content;
  translateStaticPage(must("#accountContent"));
  must<HTMLImageElement>("#accountGoogleSignIn img").src = new URL("../assets/google-g.png", import.meta.url).href;
}
