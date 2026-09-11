#!/usr/bin/env python3
"""Rebuild the offline Hanja subset from the two explicitly licensed source files.

Only the standard library is required. This script does not download or crawl sites.
Source SHA-256 checks make a changed upstream file an explicit update decision.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

LIB_SHA = "dd44dcc856cf542b1022d0f39c2e9b9f8805fdcc5923be80f04849ed97ce0996"
WIKI_SHA = "ae0872f93f01d181b1c6c844e0fde5e7e3ff17a3ec2a9ee18bc4551c2452d369"
LIB_URL = "https://raw.githubusercontent.com/libhangul/libhangul/main/data/hanja/hanja.txt"
WIKI_URL = "https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz"
KOREAN = re.compile(r"[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]")
RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF),
          (0x20000, 0x2FA1F), (0x30000, 0x3347F))


def han_word(word: str) -> bool:
    # Deliberately no Unicode normalization: compatibility ideographs are distinct.
    return bool(word) and all(ord(c) == 0x3007 or any(a <= ord(c) <= b for a, b in RANGES) for c in word)


def checked_bytes(path: Path, expected: str) -> tuple[bytes, str]:
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected:
        raise SystemExit(f"Source SHA-256 differs for {path}: {digest}; review the new source before overriding the expected hash.")
    return data, digest


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--libhangul", type=Path, required=True)
    parser.add_argument("--wiktionary", type=Path, required=True)
    parser.add_argument("--libhangul-sha256", default=LIB_SHA)
    parser.add_argument("--wiktionary-sha256", default=WIKI_SHA)
    parser.add_argument("--source-date", default="2026-09-08")
    parser.add_argument("--wiktionary-dump-date", default="2026-09-01")
    parser.add_argument("--wiktionary-extracted-date", default="2026-09-05")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "apps/desktop/src/main/data")
    args = parser.parse_args()
    lib_bytes, lib_sha = checked_bytes(args.libhangul, args.libhangul_sha256)
    _, wiki_sha = checked_bytes(args.wiktionary, args.wiktionary_sha256)
    args.output_dir.mkdir(parents=True, exist_ok=True)

    readings: dict[str, list[str]] = defaultdict(list)
    characters: dict[str, list[dict]] = defaultdict(list)
    for line in lib_bytes.decode("utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        fields = line.split(":", 2)
        if len(fields) != 3:
            raise SystemExit("Unexpected libhangul row shape")
        reading, headword, text = fields
        if not han_word(headword):
            continue
        if reading not in readings[headword]:
            readings[headword].append(reading)
        if len(headword) == 1:
            sense = {"reading": reading, "text": text}
            if sense not in characters[headword]:
                characters[headword].append(sense)

    lib_entries = [{"headword": word, "readings": readings[word], "senses": senses}
                   for word, senses in sorted(characters.items())]
    lib_info = {
        "id": "libhangul", "label": "libhangul 기본 훈음", "entryCount": len(lib_entries),
        "license": "BSD-3-Clause", "licenseUrl": "https://opensource.org/license/bsd-3-clause",
        "sourceUrl": "https://github.com/libhangul/libhangul/blob/main/data/hanja/hanja.txt",
        "updatedAt": args.source_date,
        "description": "낱자별 독음과 짧은 훈. 뜻이 비어 있는 독음은 원자료의 빈 값으로 보존했습니다.",
    }
    write_json(args.output_dir / "hanja-libhangul.json", {
        "schemaVersion": 1, "dataset": lib_info,
        "provenance": {"sourceUrl": LIB_URL, "sha256": lib_sha, "retrievedAt": args.source_date,
                       "changes": "한자 낱자만 선택; 동일 표제자의 독음별 원문 훈을 병합; 빈 뜻 유지; 정규화하지 않음.",
                       "charactersWithMeaning": sum(any(s["text"] for s in e["senses"]) for e in lib_entries)},
        "entries": lib_entries,
    })

    wiki: dict[str, list[dict]] = defaultdict(list)
    records = 0
    # Select only actual Hanja headwords, not unrelated Korean homographs or translations.
    with gzip.open(args.wiktionary, "rt", encoding="utf-8") as source:
        for line in source:
            entry = json.loads(line)
            word = entry.get("word", "")
            language = entry.get("lang", "")
            if language not in {"한자", "한국어", "중국어"} or not han_word(word):
                continue
            added = False
            label = " · ".join(filter(None, [language, entry.get("pos_title", "")]))
            for sense in entry.get("senses", []):
                if "no-gloss" in sense.get("tags", []):
                    continue
                glosses = [s.strip() for s in sense.get("glosses", []) if isinstance(s, str) and s.strip()]
                text = " / ".join(glosses)
                if not KOREAN.search(text):
                    continue
                item = {"text": text, "label": label}
                if item not in wiki[word]:
                    wiki[word].append(item)
                    added = True
            records += int(added)
    wiki_entries = [{"headword": word, "readings": readings.get(word, []), "senses": senses}
                    for word, senses in sorted(wiki.items()) if senses]
    wiki_info = {
        "id": "wiktionary", "label": "한국어 위키낱말사전", "entryCount": len(wiki_entries),
        "license": "CC-BY-SA-4.0", "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
        "sourceUrl": "https://kaikki.org/kowiktionary/rawdata.html", "updatedAt": args.source_date,
        "description": "한국어판의 한자·한국어·중국어 구역에서 한국어 뜻풀이가 있는 한자 표제어를 추출했습니다. 예문·인용문·매체는 제외했으며 한국어 독음은 libhangul에서 보완했습니다.",
    }
    write_json(args.output_dir / "hanja-wiktionary.json", {
        "schemaVersion": 1, "dataset": wiki_info,
        "provenance": {
            "sourceUrl": WIKI_URL, "sha256": wiki_sha, "retrievedAt": args.source_date,
            "dumpDate": args.wiktionary_dump_date, "extractedAt": args.wiktionary_extracted_date,
            "readingSourceSha256": lib_sha,
            "changes": "한자 표제어와 한국어 뜻풀이만 선별; 언어·품사별 의미 병합; 예문·인용문·미디어·번역·어원 제외; 한국어 독음은 libhangul에서 보완; Unicode 정규화하지 않음.",
            "attribution": "한국어 위키낱말사전 기여자; 일부 국립국어원 자료(CC-BY-SA-2.0-KR); 추출 Kaikki/Wiktextract(Tatu Ylonen 및 기여자); 독음 Choe Hwanjin/libhangul(BSD-3-Clause).",
            "historyUrlTemplate": "https://ko.wiktionary.org/w/index.php?title={encodedHeadword}&action=history",
            "upstreamTermsUrl": "https://ko.wiktionary.org/wiki/위키낱말사전:저작권",
            "niklLicenseUrl": "https://creativecommons.org/licenses/by-sa/2.0/kr/",
            "characters": sum(len(e["headword"]) == 1 for e in wiki_entries),
            "words": sum(len(e["headword"]) > 1 for e in wiki_entries), "sourceRecordsWithGlosses": records,
        }, "entries": wiki_entries,
    })

    copyright_lines = []
    for line in lib_bytes.decode("utf-8").splitlines():
        if not line.startswith("#"):
            break
        copyright_lines.append(line[2:] if line.startswith("# ") else line[1:])
    notice = f"""Munhae offline Hanja dictionary data — source and license notices

Generated from sources retrieved {args.source_date}. Application code is separate from these data licenses.

1. hanja-libhangul.json: BSD 3-Clause
Source: {LIB_URL}
SHA-256: {lib_sha}
Changes: character subset; reading-specific glosses merged without rewriting; empty meanings retained.
The following notice applies to the source data and the readings used in the Wiktionary subset:

{chr(10).join(copyright_lines)}

2. hanja-wiktionary.json: Creative Commons Attribution-ShareAlike 4.0 International
License: https://creativecommons.org/licenses/by-sa/4.0/
Legal code: https://creativecommons.org/licenses/by-sa/4.0/legalcode
Authors: Korean Wiktionary contributors. Each headword's authors and edits are credited via
https://ko.wiktionary.org/w/index.php?title=URL_ENCODED_HEADWORD&action=history
Original text: https://ko.wiktionary.org/wiki/URL_ENCODED_HEADWORD
Some original entries include National Institute of Korean Language (국립국어원) material:
https://creativecommons.org/licenses/by-sa/2.0/kr/ ; https://opendict.korean.go.kr/
Extraction: Kaikki.org / Wiktextract, Tatu Ylonen and contributors.
Source: {WIKI_URL}
SHA-256: {wiki_sha}
Wikimedia dump: {args.wiktionary_dump_date}; Kaikki extraction: {args.wiktionary_extracted_date}.
Changes: selected Han-only headwords in 한자/한국어/중국어 sections with Korean glosses;
merged glosses while retaining language/part-of-speech labels; omitted examples, quotations,
etymologies, translations, audio and images; added Korean readings from libhangul (BSD 3-Clause).
No NFKC/NFC normalization of Han characters. The adapted Wiktionary dataset is distributed
under CC-BY-SA-4.0. Preserve attribution and this license when sharing adapted dictionary data.
No endorsement by the original authors or institutions is implied.

Regeneration (from repository root; downloads are separate):
python3 scripts/build-hanja-dictionary.py --libhangul PATH/hanja.txt --wiktionary PATH/kowiktionary.jsonl.gz
The script checks the original hashes before generating data. Update hashes and source dates
explicitly only after reviewing a new source release. See JSON provenance for measured counts.
"""
    (args.output_dir / "hanja-NOTICE.txt").write_text(notice, encoding="utf-8")
    print(json.dumps({"libhangul": lib_info, "wiktionary": wiki_info}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
