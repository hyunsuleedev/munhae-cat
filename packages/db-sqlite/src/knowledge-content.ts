import { canonicalJson, canonicalJsonHash } from "@munhae/domain";

export type ContextItemContent = {
  scopeId: string;
  title: string;
  contentMd: string;
  priority: number;
  enabled: boolean;
};

export function contextItemContentHash(value: ContextItemContent): string {
  return canonicalJsonHash({
    scopeKind: "document_node",
    scopeId: value.scopeId,
    title: value.title.trim(),
    contentMd: value.contentMd,
    priority: value.priority,
    enabled: value.enabled,
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

export type PersonContent = {
  preferredName: string;
  hanjaName: string | null;
  reading: string | null;
  aliases: string[];
  descriptionMd: string | null;
  dateText: string | null;
};

export type PlaceContent = {
  preferredName: string;
  hanjaName: string | null;
  reading: string | null;
  aliases: string[];
  placeKind: string | null;
  locationNoteMd: string | null;
  descriptionMd: string | null;
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

function personManifest(value: PersonContent): PersonContent {
  return {
    preferredName: value.preferredName,
    hanjaName: value.hanjaName,
    reading: value.reading,
    aliases: [...value.aliases],
    descriptionMd: value.descriptionMd,
    dateText: value.dateText,
  };
}

function placeManifest(value: PlaceContent): PlaceContent {
  return {
    preferredName: value.preferredName,
    hanjaName: value.hanjaName,
    reading: value.reading,
    aliases: [...value.aliases],
    placeKind: value.placeKind,
    locationNoteMd: value.locationNoteMd,
    descriptionMd: value.descriptionMd,
  };
}

export function glossaryContentJson(value: GlossaryContent): string {
  return canonicalJson(glossaryManifest(value));
}

export function glossaryContentHash(value: GlossaryContent): string {
  return canonicalJsonHash(glossaryManifest(value));
}

export function personContentJson(value: PersonContent): string {
  return canonicalJson(personManifest(value));
}

export function personContentHash(value: PersonContent): string {
  return canonicalJsonHash(personManifest(value));
}

export function placeContentJson(value: PlaceContent): string {
  return canonicalJson(placeManifest(value));
}

export function placeContentHash(value: PlaceContent): string {
  return canonicalJsonHash(placeManifest(value));
}
