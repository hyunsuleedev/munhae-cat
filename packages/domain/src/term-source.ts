/** The saved text against which terminology quotations and offsets are validated. */
export function termSource(editor: {
  source: { versionId: string; lockVersion: number; contentText: string };
  punctuation: { versionId: string; lockVersion: number; state: string; punctuatedText: string } | null;
}) {
  const version = `${editor.source.versionId}:${editor.source.lockVersion}`;
  const p = editor.punctuation;
  if (p && (p.state === "draft" || p.state === "confirmed") && p.punctuatedText.trim()) {
    return { text: p.punctuatedText, version: `${version}:punctuation:${p.versionId}:${p.lockVersion}`, kind: "punctuation" as const, label: "표점본" };
  }
  return { text: editor.source.contentText, version, kind: "source" as const, label: "원문" };
}
