import { canonicalJson, canonicalJsonHash } from "@munhae/domain";
import type { MaterialOrigin } from "./views.ts";

export function materialOriginFromJson(value: string | null): MaterialOrigin | null {
  return value ? JSON.parse(value) as MaterialOrigin : null;
}

export type ContextItemContent = {
  scopeId: string;
  title: string;
  contentMd: string;
  priority: number;
  enabled: boolean;
  inheritToChildren?: boolean;
  conditionMd?: string;
};

export function contextItemContentHash(value: ContextItemContent): string {
  return canonicalJsonHash({
    scopeKind: "document_node",
    scopeId: value.scopeId,
    title: value.title.trim(),
    contentMd: value.contentMd,
    priority: value.priority,
    enabled: value.enabled,
    ...(value.inheritToChildren === false ? { inheritToChildren: false } : {}),
    ...(value.conditionMd?.trim() ? { conditionMd: value.conditionMd.trim() } : {}),
  });
}

export type GlossaryContent = {
  sourceTerm: string;
  targetTerm: string;
  targetLocale: string;
  termKind: string;
  reading: string | null;
  noteMd: string | null;
  usageStatus: "preferred" | "allowed" | "forbidden";
};

function glossaryManifest(value: GlossaryContent): GlossaryContent {
  return {
    sourceTerm: value.sourceTerm,
    targetTerm: value.targetTerm,
    targetLocale: value.targetLocale,
    termKind: value.termKind,
    reading: value.reading,
    noteMd: value.noteMd,
    usageStatus: value.usageStatus,
  };
}

export function glossaryContentJson(value: GlossaryContent): string {
  return canonicalJson(glossaryManifest(value));
}

export function glossaryContentHash(value: GlossaryContent): string {
  return canonicalJsonHash(glossaryManifest(value));
}
