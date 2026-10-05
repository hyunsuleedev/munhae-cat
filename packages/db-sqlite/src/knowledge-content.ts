import { canonicalJsonHash } from "@munhae/domain";
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
