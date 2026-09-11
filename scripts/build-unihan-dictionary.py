#!/usr/bin/env python3
"""Build a compact, property-only Unicode 17 Unihan subset; no network or definitions."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

VERSION = "17.0.0"
SOURCE_URL = f"https://www.unicode.org/Public/{VERSION}/ucd/Unihan.zip"
RADICALS_URL = f"https://www.unicode.org/Public/{VERSION}/ucd/CJKRadicals.txt"
LICENSE_URL = "https://www.unicode.org/license.txt"
ZIP_SHA = "f7a48b2b545acfaa77b2d607ae28747404ce02baefee16396c5d2d7a8ef34b5e"
RADICALS_SHA = "826f83be25cd18fb8a5015a514704504e1982e840ea14d058bf583e1cc620c83"
LICENSE_SHA = "e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96"
VARIANTS = {"kSemanticVariant": "semantic", "kSpecializedSemanticVariant": "specializedSemantic",
            "kZVariant": "z", "kTraditionalVariant": "traditional", "kSimplifiedVariant": "simplified"}
PROPERTIES = {"kHangul", "kRSUnicode", "kTotalStrokes", *VARIANTS}


def checked(path: Path, expected: str) -> bytes:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        raise SystemExit(f"Unexpected SHA-256 for {path}: {digest}. Review the upstream release before updating hashes.")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unihan", type=Path, required=True)
    parser.add_argument("--radicals", type=Path, required=True)
    parser.add_argument("--license", type=Path, required=True)
    parser.add_argument("--unihan-sha256", default=ZIP_SHA)
    parser.add_argument("--radicals-sha256", default=RADICALS_SHA)
    parser.add_argument("--license-sha256", default=LICENSE_SHA)
    parser.add_argument("--source-date", default="2026-09-08")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "apps/desktop/src/main/data")
    args = parser.parse_args()
    raw_zip = checked(args.unihan, args.unihan_sha256)
    raw_radicals = checked(args.radicals, args.radicals_sha256)
    license_text = checked(args.license, args.license_sha256).decode("utf-8")
    if "UNICODE LICENSE V3" not in license_text:
        raise SystemExit("Expected Unicode License V3")

    radicals = {}
    for line in raw_radicals.decode("utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            key, _, unified = [value.strip() for value in line.split(";")]
            radicals[key] = chr(int(unified, 16))

    records: dict[int, dict[str, str]] = defaultdict(dict)
    counts: Counter[str] = Counter()
    with zipfile.ZipFile(io.BytesIO(raw_zip)) as archive:
        # UAX38 warns that properties may move between Unihan files. Inspect all
        # official text members, without extracting filesystem paths from the ZIP.
        for member in sorted(archive.namelist()):
            if not member.startswith("Unihan_") or not member.endswith(".txt"):
                continue
            for line in archive.read(member).decode("utf-8").splitlines():
                if not line or line.startswith("#"):
                    continue
                code, property_name, value = line.split("\t", 2)
                if property_name not in PROPERTIES:
                    continue
                cp = int(code[2:], 16)
                if property_name in records[cp]:
                    raise SystemExit(f"Duplicate property: {code} {property_name}")
                records[cp][property_name] = value
                counts[property_name] += 1

    entries = []
    for cp, values in sorted(records.items()):
        rs = values.get("kRSUnicode", "")
        for token in rs.split():
            match = re.fullmatch(r"([1-9]\d{0,2})('{0,3})\.(-?\d{1,2})", token)
            if not match or not 1 <= int(match[1]) <= 214 or match[1] + match[2] not in radicals:
                raise SystemExit(f"Unsupported radical-stroke token U+{cp:X}: {token}")
        strokes = values.get("kTotalStrokes", "")
        if not re.fullmatch(r"[1-9]\d{0,2}", strokes):
            raise SystemExit(f"Unicode 17 expects a single default kTotalStrokes U+{cp:X}: {strokes}")
        hangul = []
        for token in values.get("kHangul", "").split():
            reading, sources = token.rsplit(":", 1)
            if not re.fullmatch(r"[01ENX]{1,3}", sources) or not reading:
                raise SystemExit(f"Unexpected kHangul token: {token}")
            if reading not in hangul:
                hangul.append(reading)
        variants = {}
        for property_name, kind in VARIANTS.items():
            value = values.get(property_name)
            if value:
                for token in value.split():
                    if not re.match(r"^U\+[0-9A-F]{4,6}(?:<|$)", token):
                        raise SystemExit(f"Unexpected variant token: {token}")
                variants[kind] = value
        # Compact row: code point, unmodified radical-stroke tokens, default
        # strokes, Hangul without source codes, typed variant source values.
        entries.append([cp, rs, int(strokes), hangul, variants])

    dataset = {
        "id": "unihan", "label": "Unicode Unihan 문자 속성", "entryCount": len(entries),
        "license": "Unicode-3.0", "licenseUrl": LICENSE_URL,
        "sourceUrl": SOURCE_URL, "updatedAt": args.source_date,
        "description": "Unicode 17.0.0의 한국어 독음·부수·획수·종류별 이체 관계. 한국어 뜻풀이 사전이 아니며 영어 정의는 포함하지 않습니다.",
    }
    output = {
        "schemaVersion": 1, "unicodeVersion": VERSION, "dataset": dataset,
        "provenance": {
            "retrievedAt": args.source_date,
            "sources": [{"url": SOURCE_URL, "sha256": args.unihan_sha256},
                        {"url": RADICALS_URL, "sha256": args.radicals_sha256},
                        {"url": LICENSE_URL, "sha256": args.license_sha256}],
            "specificationUrl": "https://www.unicode.org/reports/tr38/tr38-39.html",
            "properties": sorted(PROPERTIES), "propertyCounts": dict(sorted(counts.items())),
            "changes": "지정된 문자 속성만 추출. kHangul 소스 코드는 독음에서 제거. kRSUnicode 및 이체 원본값·순서 보존. 부수 글자는 CJKRadicals의 대응 통합한자 사용. 뜻풀이·kDefinition·예문 제외. 원문 코드포인트 정규화·이체 자동 치환 없음.",
            "rowColumns": ["codePoint", "kRSUnicode", "kTotalStrokes", "hangulReadings", "variantValuesByKind"],
            "multipleRadicalCharacters": sum(len(e[1].split()) > 1 for e in entries),
            "supplementaryCharacters": sum(e[0] > 0xFFFF for e in entries),
        }, "radicals": radicals, "entries": entries,
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "hanja-unihan.json").write_text(json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    notice = f"""Munhae Unicode Unihan character-property subset

Unicode version: {VERSION}; source retrieval: {args.source_date}.
Source: {SOURCE_URL}
SHA-256: {args.unihan_sha256}
Radical mapping: {RADICALS_URL}
SHA-256: {args.radicals_sha256}
License source: {LICENSE_URL}
SHA-256: {args.license_sha256}
Attribution: Unicode, Inc. and contributors; CJKRadicals source credits Richard Cook,
Ken Whistler and Laurentiu Iancu. No endorsement is implied.
Properties retained: {', '.join(sorted(PROPERTIES))}.
Changes: only these properties are retained, in compact rows. Korean reading source codes
are removed from display readings. Original radical-stroke and variant values are preserved;
radical glyphs use the official CJKRadicals unified-ideograph mapping. kDefinition, definitions,
examples and dictionary quotations are not included. No Han character normalization or
automatic variant substitution is performed. Default total strokes remain separate from
radical residual strokes; Unicode 17 kTotalStrokes is a single default count.

Regenerate from the repository root:
python3 scripts/build-unihan-dictionary.py --unihan PATH/Unihan-17.0.0.zip --radicals PATH/CJKRadicals-17.0.0.txt --license PATH/Unicode-License-v3-20260908.txt
The script verifies source hashes and performs no download or crawling.

The following complete notice is distributed with the derived data:

{license_text}
"""
    (args.output_dir / "hanja-Unihan-NOTICE.txt").write_text(notice, encoding="utf-8")
    print(json.dumps({"dataset": dataset, "counts": output["provenance"]["propertyCounts"], "bytes": (args.output_dir / "hanja-unihan.json").stat().st_size}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
