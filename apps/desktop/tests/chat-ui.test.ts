import { describe, expect, it, vi } from "vitest";
import { chatMarkdown, chatMessageMarkup, isChatSubmit, loadChatDraft, saveChatDraft } from "../src/renderer/scripts/chat-ui";

describe("chat presentation", () => {
  it("renders research prose and source links without changing original characters", () => {
    const html = chatMarkdown('## 해석\n\n> 捕取等嬰兒\n\n**謚**와 諡\n\n- 항목\n\n[출처](https://example.com/source)\n\n| 원문 | 번역 |\n| --- | --- |\n| 嬰兒 | 아이 |');
    for (const tag of ['<h2>', '<blockquote>', '<strong>謚</strong>', '<ul>', '<table>', 'href="https://example.com/source"', 'target="_blank"']) expect(html).toContain(tag);
    expect(html).toContain('捕取等嬰兒');
  });
  it("does not execute HTML or load external images and rejects non-web links", () => {
    const html = chatMarkdown('<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [file](file:///etc/passwd) ![image](https://example.com/pixel.png)');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).not.toContain('href=');
    expect(chatMessageMarkup({ role: 'user', text: '<img onerror=alert(1)> **literal**' }, 0)).toContain('&lt;img');
  });
  it("guards Korean composition and retains multiline Enter", () => {
    const key = { metaKey: true, ctrlKey: false, key: 'Enter', keyCode: 13, isComposing: false };
    expect(isChatSubmit(key as KeyboardEvent)).toBe(true);
    expect(isChatSubmit({ ...key, isComposing: true } as KeyboardEvent)).toBe(false);
    expect(isChatSubmit({ ...key, keyCode: 229 } as KeyboardEvent)).toBe(false);
    expect(isChatSubmit({ ...key, metaKey: false } as KeyboardEvent)).toBe(false);
  });
  it("isolates and clears drafts by conversation without touching another draft", () => {
    const values = new Map();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
    try {
      saveChatDraft('doc:a', '질문 A'); saveChatDraft('doc:b', '질문 B'); saveChatDraft('doc:a', '');
      expect(loadChatDraft('doc:a')).toBe(''); expect(loadChatDraft('doc:b')).toBe('질문 B');
    } finally { vi.unstubAllGlobals(); }
  });
});
