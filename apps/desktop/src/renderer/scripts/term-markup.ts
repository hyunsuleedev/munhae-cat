/** Match the original text once: generated attributes must never be matched again. */
export function termMarkup(text: string, terms: string[], escape: (value: string) => string): string {
  const keys = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  let result = "", plain = "", index = 0;
  while (index < text.length) {
    const term = keys.find((key) => text.startsWith(key, index));
    if (term) {
      result += escape(plain) + `<span class="term" data-term="${escape(term)}">${escape(term)}</span>`;
      plain = "";
      index += term.length;
    } else {
      const character = String.fromCodePoint(text.codePointAt(index)!);
      plain += character;
      index += character.length;
    }
  }
  return result + escape(plain);
}
