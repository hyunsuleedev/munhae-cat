import {
  canonicalJson,
  codepointCount,
  MunhaeError,
  sha256Hex,
  sliceCodepoints,
  translationEnvelopeJsonSchema,
  utf8ByteLength,
} from "@munhae/domain";

export const TRANSLATION_PROMPT_CONTRACT_VERSION = "munhae.translation.v9";

export type TranslationRequestAnchor = {
  anchorKey: string;
  ordinal: number;
  boundaryKind: string;
  punctuationFrom: number;
  punctuationTo: number;
  required: boolean;
  quoteHash?: string;
};

export type TranslationRequestContextItem = {
  id: string;
  kind: string;
  label: string;
  content: string;
  hash: string;
  reason: string;
  selection: "auto" | "pin" | "exclude";
};

export type RenderTranslationRequestInput = {
  documentTitle: string;
  anchorSetId: string;
  punctuatedText: string;
  anchors: TranslationRequestAnchor[];
  policyText: string;
  metadataText: string;
  auxiliary: TranslationRequestContextItem[];
};

export type RenderedTranslationRequest = {
  promptContractVersion: typeof TRANSLATION_PROMPT_CONTRACT_VERSION;
  outputSchema: Record<string, unknown>;
  outputSchemaJson: string;
  anchoredSource: string;
  requestText: string;
  requestHash: string;
  characterCount: number;
  utf8ByteCount: number;
};

/** Renders the complete source once, annotated with stable anchor keys. */
export function renderAnchoredSource(text: string, anchors: TranslationRequestAnchor[]): string {
  const ordered = [...anchors].sort((a, b) => a.ordinal - b.ordinal);
  const length = codepointCount(text);
  let cursor = 0;
  const output: string[] = [];
  const keys = new Set<string>();
  for (const anchor of ordered) {
    if (keys.has(anchor.anchorKey)) {
      throw new MunhaeError("invalid_anchor_set", `duplicate anchor key: ${anchor.anchorKey}`);
    }
    keys.add(anchor.anchorKey);
    if (
      !Number.isInteger(anchor.punctuationFrom) ||
      !Number.isInteger(anchor.punctuationTo) ||
      anchor.punctuationFrom < cursor ||
      anchor.punctuationTo <= anchor.punctuationFrom ||
      anchor.punctuationTo > length
    ) {
      throw new MunhaeError("invalid_anchor_set", `invalid anchor range: ${anchor.anchorKey}`);
    }
    if (anchor.punctuationFrom > cursor) output.push(sliceCodepoints(text, cursor, anchor.punctuationFrom));
    const quote = sliceCodepoints(text, anchor.punctuationFrom, anchor.punctuationTo);
    if (anchor.quoteHash && sha256Hex(quote) !== anchor.quoteHash) {
      throw new MunhaeError("invalid_anchor_set", `anchor quote hash mismatch: ${anchor.anchorKey}`);
    }
    output.push(`[${anchor.anchorKey}]${quote}`);
    cursor = anchor.punctuationTo;
  }
  if (cursor < length) output.push(sliceCodepoints(text, cursor, length));
  return output.join("");
}

export function renderTranslationRequest(input: RenderTranslationRequestInput): RenderedTranslationRequest {
  const outputSchema = translationEnvelopeJsonSchema();
  const outputSchemaJson = canonicalJson(outputSchema);
  const anchoredSource = renderAnchoredSource(input.punctuatedText, input.anchors);
  const anchorManifest = canonicalJson({
    anchorSetId: input.anchorSetId,
    anchors: [...input.anchors]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((anchor) => ({
        anchorKey: anchor.anchorKey,
        ordinal: anchor.ordinal,
        boundaryKind: anchor.boundaryKind,
        required: anchor.required,
        punctuationFrom: anchor.punctuationFrom,
        punctuationTo: anchor.punctuationTo,
        quoteHash: anchor.quoteHash,
      })),
  });
  const seenContextIds = new Set<string>();
  const includedAuxiliary = input.auxiliary.filter((item) => {
    if (seenContextIds.has(item.id)) {
      throw new MunhaeError("invalid_context", `duplicate context item: ${item.id}`);
    }
    seenContextIds.add(item.id);
    if (item.hash !== sha256Hex(item.content)) {
      throw new MunhaeError("invalid_context", `context item hash mismatch: ${item.id}`);
    }
    return item.selection !== "exclude";
  });
  const auxiliary = includedAuxiliary
    .map(
      (item, index) =>
        `### ${index + 1}. ${item.label}\nkind=${item.kind}; id=${item.id}; reason=${item.reason}; sha256=${item.hash}\n${item.content}`,
    )
    .join("\n\n");
  const requestText = [
    "# Munhae structured document translation",
    `promptContract=${TRANSLATION_PROMPT_CONTRACT_VERSION}`,
    "You translate a complete Classical Chinese document into the target language specified in the translation policy for a research-oriented CAT workflow.",
    "Use the supplied text and context as the source evidence. Do not access or modify Munhae project files or its SQLite database.",
    "Munhae Studio launched this CLI run and supplied MUNHAE_NODE_BIN and MUNHAE_BIN in the process environment. They resolve to the app's Node runtime and bundled submission wrapper.",
    "The wrapper cannot open the project database. It sends one authenticated loopback request to the already-open app for this run, where the user will immediately see and edit the submitted translation.",
    "The human user explicitly started this translation run and authorizes creation of one local editable draft. Submission does not confirm or publish the translation, overwrite confirmed work, or affect an external service.",
    "Review the JSON you create before submitting it; you are not being asked to forward uninspected third-party content.",
    "You may inspect the supplied environment or wrapper with your native tools if useful. When the translation is complete, pass exactly one JSON object conforming to the supplied schema through standard input to this app-owned command exactly once:",
    '"$MUNHAE_NODE_BIN" "$MUNHAE_BIN" tools submit-translation',
    "Use your native shell tool with a quoted heredoc or an equivalent pipeline that preserves the JSON exactly. Do not add command arguments.",
    "The command's standard input is the application handoff path. Assistant prose is not treated as a submission, but you may transparently summarize what you submitted after it succeeds; the complete translation is also shown in the editor.",
    "Do not repeat the source text in translation fields. sourceAnchorIds must use only the supplied anchor keys.",
    "You may use any internal translation and review process, but submit only one completed translation. Do not expose or store internal drafts, alternatives, review steps, or reasoning.",
    "The submitted blocks together must form one complete translation. Review the sourceAnchorIds mapping yourself so the entire source is represented appropriately; the app checks only the JSON contract and whether referenced anchors belong to the current anchor set, not semantic completeness or one-to-one coverage.",
    "You decide the sourceAnchorIds order and grouping for the most natural complete translation in the requested language; groups do not have to follow source order or contain contiguous anchors.",
    "Important terms should keep translated terms with original Chinese characters when the policy requests it. Mark information supplied beyond the source according to policy.",
    `\n## Document\n${input.documentTitle}\n${input.metadataText}`,
    `\n## Translation policy\n${input.policyText}`,
    `\n## Complete punctuated source with anchor markers\nanchorSetId=${input.anchorSetId}\n${anchoredSource}`,
    `\n## Anchor manifest (the source text is not repeated here)\n${anchorManifest}`,
    auxiliary ? `\n## Selected auxiliary context\n${auxiliary}` : "\n## Selected auxiliary context\n(none)",
    `\n## Required app submission JSON Schema\n${outputSchemaJson}`,
  ].join("\n");
  return {
    promptContractVersion: TRANSLATION_PROMPT_CONTRACT_VERSION,
    outputSchema,
    outputSchemaJson,
    anchoredSource,
    requestText,
    requestHash: sha256Hex(requestText),
    characterCount: codepointCount(requestText),
    utf8ByteCount: utf8ByteLength(requestText),
  };
}
