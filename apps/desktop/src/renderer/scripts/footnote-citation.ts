import type { ItkcFootnote } from "../../shared/munhae-api";

export function footnoteCitation(note: ItkcFootnote): string {
  const publication = [note.bookTitle && `《${note.bookTitle}》`, note.translator && `${note.translator} 역`, note.publisher, note.year]
    .filter(Boolean).join(" · ");
  return [
    "[한국고전종합DB 각주 참고자료]",
    `각주 대상 구절: ${note.annotatedText}`,
    note.displayTitle && note.displayTitle !== note.annotatedText ? `표시 제목: ${note.displayTitle}` : "",
    `각주 설명: ${note.bodyText}`,
    `출처: ${publication || "서지 정보 없음"}`,
    `자료: ${note.sourceUrl}`,
  ].filter(Boolean).join("\n");
}

export function appendFootnoteCitation(body: string, note: ItkcFootnote, maxLength = 20_000): string {
  const citation = footnoteCitation(note);
  if (body.includes(citation)) throw new Error("이 각주 자료는 이미 코멘트에 들어 있습니다.");
  const combined = `${body}${body ? "\n\n" : ""}${citation}`;
  if (combined.length > maxLength) throw new Error("각주를 모두 넣으면 코멘트의 20,000자 제한을 넘습니다. 필요한 부분을 골라 입력해 주세요.");
  return combined;
}
