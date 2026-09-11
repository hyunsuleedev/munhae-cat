# 오프라인 한자 사전 데이터

조회 모듈: `apps/desktop/src/main/dictionary-local.ts`.
`searchLocalDictionary(query, page?)`와 `getLocalDictionaryDatasets()`는 동기 함수다.
JSON은 별도 Electron main 청크에 포함되며 사전 서비스가 처음 필요할 때 지연 로드한다. 앱 시작 시에는 읽지 않으며 네트워크·SQLite·별도 네이티브 모듈이 필요하지 않다.

## 수록 범위와 실제 수치

2026-09-08에 받은 아래 공식 배포 자료에서 생성했다. 수치는 원본 전체 행 수가 아니라 자료별로 생성된 고유 표제어 수다. 자료 사이에 같은 글자가 중복되므로 합계를 고유 한자 수로 보면 안 된다.

| 자료 | 표제어 수 | 내용 | 데이터 라이선스 |
|---|---:|---|---|
| libhangul | 낱자 27,552자 | 독음과 짧은 훈. 7,374자에 하나 이상의 훈이 있고 나머지는 독음만 있다 | BSD-3-Clause |
| 한국어 위키낱말사전 | 50,563개 = 낱자 5,442자 + 어휘 45,121개 | 한국어 뜻풀이, 원문 언어·품사 구분 | CC-BY-SA-4.0 |
| Unicode Unihan 17.0.0 | 낱자 102,998자 | 문자 속성 전용. 8,525자에 한국어 독음, 부수·획수·종류별 이체 관계 | Unicode-3.0 |

위키 자료는 **한국어판**의 `한자`, `한국어`, `중국어` 구역 중 한자로만 이루어진 표제어를 선택했다. 적어도 한 개의 한국어 뜻풀이가 있는 항목만 남겼다. 중국어 표제어도 뜻풀이는 한국어지만 현대 중국어 어휘가 포함되므로 고전 전용 사전은 아니다. 한국어 독음은 libhangul에 해당 표제어가 실제 있을 때만 보완했다. 낱자 독음을 조합하여 어휘 독음을 추측하지 않는다.

예문·번역 예문·인용문 필드·이미지·오디오·어원·다른 언어 번역을 포함하지 않는다. 같은 표제어의 뜻풀이를 언어·품사 표시와 함께 병합했다. 위키 원문 및 추출 오류가 남아 있을 수 있다. 한자 표제어에 NFC/NFKC 정규화를 적용하지 않았다.

원본:

- [libhangul hanja.txt](https://raw.githubusercontent.com/libhangul/libhangul/main/data/hanja/hanja.txt)
- [Kaikki 한국어판 JSONL.GZ](https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz), [배포 안내](https://kaikki.org/kowiktionary/rawdata.html)
- [Unicode 17.0.0 Unihan.zip](https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip), [CJKRadicals.txt](https://www.unicode.org/Public/17.0.0/ucd/CJKRadicals.txt), [Unicode License V3](https://www.unicode.org/license.txt)

위키 덤프 기준일은 2026-09-01, Kaikki 추출일은 2026-09-05다. 파일 해시를 검증하므로 최신 URL의 내용이 바뀌면 의도적인 갱신 없이는 재생성이 실패한다.

## 저작자 표시와 배포

`apps/desktop/src/main/data/hanja-NOTICE.txt`에 BSD 전문, CC 라이선스 링크, 원저작자·추출자, 가공 내용, 원본 SHA-256, 날짜, 재생성 방법이 있다. `hanja-Unihan-NOTICE.txt`에는 Unicode License V3 전문과 같은 종류의 출처·가공 정보를 기록했다. **설치형 앱 배포에도 두 NOTICE 파일을 포함해야 한다.** `electron-builder.yml`의 `extraResources`는 두 파일을 `licenses/`에 넣는다. 세 JSON의 `dataset`과 `provenance`에는 구조화된 출처 및 실제 수록량을 기록했다.

한국어 위키낱말사전의 [저작권 안내](https://ko.wiktionary.org/wiki/위키낱말사전:저작권)에 따라 가공 위키 데이터는 CC-BY-SA-4.0으로 배포한다. 일부 원문에는 국립국어원 자료(CC-BY-SA-2.0-KR)가 포함되어 있으므로 해당 기관 표시도 남긴다. 어휘별 `sourceUrl`은 위키 원문, `attribution`은 해당 문서의 편집 이력 링크를 제공한다. libhangul에서 보완한 독음은 BSD 출처를 함께 표시한다. 사전 데이터를 담은 인용·용어집을 공유할 때도 표시된 출처·라이선스·가공 고지를 유지해야 한다. 앱 코드와 사전 데이터의 라이선스는 구분한다.

## 조회 동작

1. 완전 일치 한자 표제어.
2. 완전 일치 한국어 독음.
3. 입력 문자열에 들어 있는 낱자(원문 등장 순서).
4. 표제어 또는 한국어 독음의 접두어 일치.

동일 순위에서는 뜻이 있는 항목을 먼저 표시하며 한 페이지는 20개다. `total`은 낱자 보완·접두어까지 포함한 조회 결과 수, `hasMore`는 해당 순서의 다음 페이지 유무다. 결과와 메타데이터는 복사하여 반환하므로 호출자가 값을 수정해도 다음 조회에 영향을 주지 않는다.

- `目`: libhangul 훈음과 위키 자의. `목`으로도 검색 가능.
- `謚`: `시`의 빈 뜻과 `익`의 훈을 분리한다. `諡`로 자동 치환하지 않는다.
- `太守`: 위키의 실제 어휘 뜻을 낱자 `太`, `守`보다 먼저 표시. `태수` 검색 가능.
- `提調`: 이 번들에는 실제 어휘가 없으므로 낱자 보완임을 알린다.
- `𠮷`: Unihan의 문자 속성만 있다. 口 부수, 부수 외 3획, 총 6획을 표시하며 한국어 독음·뜻을 추측하거나 `吉`로 바꾸지 않는다. `𪚥` 등 수록된 BMP 밖 글자는 낱자로 정상 처리한다.

libhangul의 빈 뜻은 `senses[].text === ""`와 `뜻 미수록` 라벨로 전달된다. 빈 값을 뜻처럼 인용하면 안 된다. 모든 뜻이 빈 항목은 `canCite: false`다. 원문에 뜻이 있는 항목도 그 의미가 현재 문맥에 맞는지는 번역가가 판단한다.

## Unicode 문자 속성의 해석

Unihan은 한국어 뜻풀이 사전이 아니다. `source: "unihan"`인 결과는 `senses: []`, `canCite: false`이며 `characterInfo`에서 속성을 제공한다. 영어 `kDefinition`이나 예문은 번들에 넣지 않는다. 다른 사전의 뜻풀이에 합치지 않고 출처가 분리된 결과로 반환한다.

[Unicode 17.0.0 UAX #38](https://www.unicode.org/reports/tr38/tr38-39.html)의 속성 의미를 따른다.

- `kHangul`의 `목:0E` 등에서 `:` 뒤 소스 코드를 제거하여 한국어 독음만 표시·검색한다. 소스 코드는 뜻이나 신뢰도 점수가 아니다. `謚`의 Unihan 독음은 `익`이며 libhangul의 복수 독음과 별개다.
- `kRSUnicode`는 복수 부수와 각 부수 외 획수를 모두 보존한다. `王`의 `96.-1` 같은 음수도 유지하며 총획으로 계산하지 않는다. 아포스트로피 1개는 중국 간화 부수, 2·3개는 서로 다른 비중국 간화 형태다. `variantIndex`와 `raw`에 구분을 남긴다. 부수 글자는 공식 `CJKRadicals.txt`의 대응 통합한자를 사용한다.
- Unicode 17의 `kTotalStrokes`는 기본 총획수 한 값이다. 반환형은 배열이지만 현재 각 결과는 한 값만 담으며 과거 판의 중국·대만 순서 규칙을 적용하지 않는다. 별도 속성 `kAlternateTotalStrokes`는 이번 번들에 포함하지 않았다.
- `semantic`, `specializedSemantic`, `z`, `traditional`, `simplified`를 구분한다. 각각 의미 관련 이체, 특정 문맥의 의미 관련 이체, 같은 추상 자형의 중복 부호화, 중국 번체 대응, 중국 간체 대응이다. 출처 한정자까지 `rawValues`에 남긴다. 관계에 자기 자신이나 여러 글자가 포함되어도 삭제하지 않으며 자동 치환에 사용하지 않는다.

`hanja-unihan.json`은 3,128,182바이트다. 그중 BMP 밖 글자는 74,942자, 복수 부수 항목은 448자다. 속성별 수록 수는 다음과 같으며 한 글자가 여러 속성에 중복 집계된다.

| 속성 | 글자 수 |
|---|---:|
| `kRSUnicode`, `kTotalStrokes` | 각각 102,998 |
| `kHangul` | 8,525 |
| `kSemanticVariant` | 3,538 |
| `kSpecializedSemanticVariant` | 525 |
| `kZVariant` | 149 |
| `kTraditionalVariant` | 6,475 |
| `kSimplifiedVariant` | 6,929 |

이 데이터는 `?raw`로 가져와 `JSON.parse`하므로 TypeScript가 10만 개의 압축 행에서 거대한 타입 조합을 추론하지 않는다. 사전 모듈의 지연 로드 경계는 그대로 유지한다.

## 재생성 및 검증

프로젝트 루트에서:

```sh
python3 scripts/build-hanja-dictionary.py \
  --libhangul /tmp/munhae-libhangul-hanja-research.txt \
  --wiktionary /tmp/munhae-dictionary-sources-20260908/kowiktionary.jsonl.gz

python3 scripts/build-unihan-dictionary.py \
  --unihan /tmp/Unihan-17.0.0.zip \
  --radicals /tmp/CJKRadicals-17.0.0.txt \
  --license /tmp/Unicode-License-v3-20260908.txt
```

Python 표준 라이브러리만 사용하며 스크립트는 다운로드·크롤링하지 않는다. 다른 경로의 동일 원본 파일을 지정해도 된다. 갱신은 원본 권리·형식을 검토한 뒤 `--libhangul-sha256`, `--wiktionary-sha256`, `--source-date`, `--wiktionary-dump-date`, `--wiktionary-extracted-date`를 명시적으로 바꾼다. 가공 규칙을 변경할 때에는 이 문서와 테스트를 함께 검토한다.

Unihan 스크립트는 ZIP·부수 대응표·라이선스의 SHA-256을 각각 검증한다. Unicode 판을 갱신할 때에는 `VERSION`과 해당 판의 명세를 함께 검토해야 하며 최신 파일의 해시만 바꿔 기존 판으로 배포하면 안 된다. ZIP의 지정 속성만 메모리에서 읽으며 파일 경로를 추출하거나 영문 뜻풀이를 저장하지 않는다.

```sh
pnpm --dir apps/desktop exec vitest run tests/dictionary-local.test.ts
```

12개 테스트로 출처별 의미·복수 독음·빈 뜻·어휘 우선·한글 독음 검색·누락 어휘 보완·BMP 밖 글자·한자 자형 보존·페이지 경계·호출자 변경 격리·속성과 뜻의 분리·복수 부수·음수 잔획·부수 형태 구분·관계 종류와 원본값 보존을 검증했다. 서비스 36개, 전송 계층 7개와 함께 55개 테스트가 통과했다. 동일 원본에서 임시 폴더로 재생성하여 세 JSON과 두 NOTICE의 바이트가 같음을 확인했다.
