import { expect, it } from "vitest";
import { termMarkup } from "../src/renderer/scripts/term-markup";
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

it("keeps overlapping scholarly terms and HTML-like names intact without nested replacements", () => {
  expect(termMarkup('太常寺與太常𠮷 <span> &', ['太常', '太常寺', '𠮷', 'span', ''], escape)).toBe('<span class="term" data-term="太常寺">太常寺</span>與<span class="term" data-term="太常">太常</span><span class="term" data-term="𠮷">𠮷</span> &lt;<span class="term" data-term="span">span</span>&gt; &amp;');
  expect(termMarkup('<"', ['<"'], escape)).toBe('<span class="term" data-term="&lt;&quot;">&lt;&quot;</span>');
});
