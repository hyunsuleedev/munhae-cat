import { describe, expect, it } from "vitest";
import { sha256Hex } from "@munhae/domain";
import { renderAnchoredSource, renderTranslationRequest } from "../src/ai-context.ts";

describe("AI translation request", () => {
  const anchors = [
    {
      anchorKey: "A001",
      ordinal: 1,
      boundaryKind: "sentence",
      punctuationFrom: 0,
      punctuationTo: 3,
      required: true,
      quoteHash: sha256Hex("天地，"),
    },
    {
      anchorKey: "A002",
      ordinal: 2,
      boundaryKind: "sentence",
      punctuationFrom: 3,
      punctuationTo: 6,
      required: true,
      quoteHash: sha256Hex("玄黃。"),
    },
  ];

  it("renders the complete source once with stable anchor markers", () => {
    const rendered = renderAnchoredSource("天地，玄黃。", anchors);
    expect(rendered).toBe("[A001]天地，[A002]玄黃。");
    expect(rendered.match(/天地，/g)).toHaveLength(1);
    expect(rendered.match(/玄黃。/g)).toHaveLength(1);
  });

  it("requests exactly one complete translation and counts the final request bytes", () => {
    const rendered = renderTranslationRequest({
      documentTitle: "천자문",
      anchorSetId: "tas-1",
      punctuatedText: "天地，玄黃。",
      anchors,
      policyText: "중요 용어는 한국어(漢字)로 병기한다.",
      metadataText: '{"genre":"prose"}',
      auxiliary: [],
    });
    expect(rendered.requestText).toContain("pass exactly one JSON object");
    expect(rendered.requestText).toContain("through standard input");
    expect(rendered.requestText).toContain('"$MUNHAE_NODE_BIN" "$MUNHAE_BIN" tools submit-translation');
    expect(rendered.requestText).toContain("quoted heredoc or an equivalent pipeline");
    expect(rendered.requestText).toContain("app-owned command exactly once");
    expect(rendered.requestText).not.toContain("submission.json");
    expect(rendered.requestText).not.toContain("submit-translation-file");
    expect(rendered.requestText).toContain("submit only one completed translation");
    expect(rendered.promptContractVersion).toBe("munhae.translation.v9");
    expect(rendered.requestText).toContain("Review the sourceAnchorIds mapping yourself");
    expect(rendered.requestText).toContain("not semantic completeness or one-to-one coverage");
    expect(rendered.requestText).not.toContain("reference every supplied anchor exactly once");
    expect(rendered.requestText).toContain("do not have to follow source order or contain contiguous anchors");
    expect(rendered.requestText).not.toContain("in source order, using contiguous anchors per block");
    expect(rendered.requestText).not.toContain("Reflection");
    expect(rendered.requestText).not.toContain("two_step");
    expect(rendered.outputSchemaJson).toContain('"schemaVersion":{"enum":[2]');
    expect(rendered.outputSchemaJson).not.toContain("candidates");
    expect(rendered.requestText).toContain("[A001]天地，[A002]玄黃。");
    expect(rendered.requestText.match(/天地，/g)).toHaveLength(1);
    expect(rendered.requestHash).toBe(sha256Hex(rendered.requestText));
    expect(rendered.characterCount).toBe(Array.from(rendered.requestText).length);
    expect(rendered.utf8ByteCount).toBe(Buffer.byteLength(rendered.requestText, "utf8"));
  });

  it("rejects stale quote hashes", () => {
    expect(() => renderAnchoredSource("天地，玄黃。", [{ ...anchors[0]!, quoteHash: sha256Hex("wrong") }])).toThrow(
      /hash mismatch/,
    );
  });

  it("omits excluded context and rejects content whose hash changed", () => {
    const excludedContent = "전송하면 안 되는 문맥";
    const includedContent = "고정한 문맥";
    const rendered = renderTranslationRequest({
      documentTitle: "천자문",
      anchorSetId: "tas-1",
      punctuatedText: "天地，玄黃。",
      anchors,
      policyText: "원문에 충실하게 번역한다.",
      metadataText: "",
      auxiliary: [
        { id: "excluded", kind: "note", label: "제외", content: excludedContent, hash: sha256Hex(excludedContent), reason: "manual", selection: "exclude" },
        { id: "pinned", kind: "note", label: "포함", content: includedContent, hash: sha256Hex(includedContent), reason: "manual", selection: "pin" },
      ],
    });
    expect(rendered.requestText).not.toContain(excludedContent);
    expect(rendered.requestText).toContain(includedContent);
    expect(() => renderTranslationRequest({
      documentTitle: "천자문",
      anchorSetId: "tas-1",
      punctuatedText: "天地，玄黃。",
      anchors,
      policyText: "원문에 충실하게 번역한다.",
      metadataText: "",
      auxiliary: [
        { id: "stale", kind: "note", label: "변경", content: "new", hash: sha256Hex("old"), reason: "manual", selection: "pin" },
      ],
    })).toThrow(/hash mismatch/);
  });
});
