import { t, ui } from "./i18n";
import type { DictionaryEntry } from "../../shared/dictionary-types";

export function dictionaryCitation(entry: DictionaryEntry, senseIndex: number): string {
  const sense = entry.senses[senseIndex];
  if (!entry.canCite || !sense?.text.trim()) throw new Error(t("이 자료는 원문 사전에서 확인해 주세요."));
  return [
    t("[사전 참고 · 문맥에 맞는 뜻인지 검토 필요]"),
    ui`표제어: ${entry.headword}${entry.reading ? ` (${entry.reading})` : ""}`,
    ui`선택한 뜻${sense.label ? ` [${sense.label}]` : ""}: ${sense.text}`,
    ui`출처: ${entry.sourceLabel}`,
    ui`자료: ${entry.sourceUrl}`,
    entry.attribution,
    ui`이용 조건: ${entry.license}${entry.licenseUrl ? ` · ${entry.licenseUrl}` : ""}`,
  ].filter(Boolean).join("\n");
}

export function appendDictionaryCitation(body: string, citation: string, maxLength = 20_000): string {
  if (body.includes(citation)) throw new Error(t("이 사전 뜻풀이는 이미 코멘트에 들어 있습니다."));
  const next = [body, citation].filter(Boolean).join("\n\n");
  if (next.length > maxLength) throw new Error(t("코멘트의 글자 수 한도를 넘습니다. 기존 내용을 줄인 뒤 다시 넣어 주세요."));
  return next;
}

export function dictionaryReferenceLinks(query: string): { label: string; url: string }[] {
  const q = Array.from(query.trim()).slice(0, 100).join("");
  return [
    { label: t("네이버 한자"), url: `https://hanja.dict.naver.com/#/search?query=${encodeURIComponent(q)}` },
    { label: t("Daum 한자"), url: `https://dic.daum.net/search.do?${new URLSearchParams({ q, dic: "hanja" })}` },
    { label: t("단국대 고문헌 어휘"), url: `https://oriental-dic.dankook.ac.kr/search/group?${new URLSearchParams({ q: `opExt†N$opStype†VCIN$query†${q}` })}` },
    { label: t("한국어 위키낱말사전"), url: `https://ko.wiktionary.org/wiki/${encodeURIComponent(q)}` },
    { label: t("존한자 사전 홈"), url: "https://zonmal.cafe24.com/" },
  ];
}
