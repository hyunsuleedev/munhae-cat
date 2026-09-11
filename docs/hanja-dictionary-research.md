# 문해 옥편·문맥 자의 기능 조사

조사일: 2026-09-08. 실제 웹 화면·요청, 공개 데이터 원본, 공식 API 명세와 현재 문해 코드를 확인했다. 이 문서는 조사와 구현 제안이며 옥편 기능 구현 완료를 뜻하지 않는다.

후속 조사: [다른 공급원의 다운로드 데이터셋·무료 및 유료 API](./hanja-dictionary-sources.md). 한국어 Kaikki 실파일, 대만 교육부 전체 사전, CC-CEDICT, 국내 사전 제휴 및 해외 유료 데이터 공급을 비교했다.

## 1. 권장 구성

**기본 옥편은 libhangul 한국어 훈음과 Unicode Unihan을 앱에 내장하고, 한자어 사전·고전 용례를 필요할 때 조회하는 구성이 현실적이다.** 글자의 일반 훈음과 해당 문장에서 채택한 뜻을 분리한다.

- 기본 조회: 한자·한글 독음·훈음·다른 음·부수·획수·이체자·출처. 외부 API 없이 오프라인 동작.
- 확장 조회: 우리말샘/표준국어대사전의 한자어, 위키낱말사전의 등록 항목, 고전 DB의 용례.
- 문맥 판단: 사전 후보와 주변 문장을 바탕으로 AI가 해석을 제안하고 번역가가 채택. 사전에 실린 설명과 AI 제안을 구분.
- 결과 활용: 해당 원문 범위의 해석 결정으로 저장하고 코멘트 반영 재번역에 연결. 프로젝트 전체에 적용할 용어만 용어집에 등록.

## 2. 사용자 링크에서 실제 확인한 기능

[확인한 페이지](https://hm.cyberseodang.or.kr/verbalTrans/classic_view.asp?idx=15635&bookPageOrder=243&listLevel=2&moreViewType=S&fromPage=QR&QrView=Y)는 《漢文독해기본패턴》의 비교 패턴 예문이다. 글자별 기본 훈음과 해당 문장의 자의를 두 줄로 제시한다. `目`의 대표 훈과 문맥상의 그물눈 의미가 구별된다. 축자 번호는 한국어 직해 순서와 연결되고 구문 패턴 설명도 따로 있다.

브라우저 DOM에서는 `.meaning-main`과 `.meaning-sub`가 분리되어 있다. 이 값은 페이지가 제공하는 저장된 정보이며, 글자를 누를 때 임의의 새 문장을 AI가 분석하는 요청은 관찰되지 않았다. `目`을 누르면 오른쪽 자의 패널에 총획수·부수·운목·자원·여러 뜻 및 용례 건수가 표시된다.

따라서 참고할 제품 구조는 다음 세 층이다.

1. 사전에 실린 글자 정보
2. 특정 문헌·문장에서 채택된 음과 뜻
3. 한국어 번역에서 그 글자·구절이 담당하는 부분

### 관찰한 실제 요청

문자 클릭은 JSON 사전 API가 아니라 iframe용 HTML 페이지를 불러온다. 아래는 `目` 클릭 때의 실제 요청이다. 식별자 의미는 페이지에서 쓰이는 방식에 근거한 설명이며 공식 외부 API 계약은 아니다.

```http
GET https://hm.cyberseodang.or.kr/verbalTrans/classic_dicHanja.asp
  ?textIdx=15635
  &listLevel=2
  &chkOriginal=1
  &viewTextIdx=15635
  &hanjaOrderNo=4340063
  &uidx=21057
  &parentDataVersion=606348496_441939423
```

HTTP 200, `text/html`을 확인했다. `textIdx`는 문장 페이지 식별자, `hanjaOrderNo`는 클릭한 글자 출현 항목, `uidx`는 해당 사전 항목을 찾는 식별자로 쓰인다. URL의 `#similar`는 브라우저 안에서의 위치이며 서버 요청에 포함되지 않는다.

[한자 자의 검색](https://hm.cyberseodang.or.kr/verbalTrans/searchTransDic.asp)에서도 실제 검색을 확인했다.

```http
POST /verbalTrans/searchTransDic.asp
Content-Type: application/x-www-form-urlencoded

bookNos=24&bookNos=10&bookNos=2&bookNos=11&bookNos=13&searchTxt=%E7%9B%AE&wordMeaning=
```

선택된 책 범위에서 `目`의 의미 그룹 4개가 반환됐다. 예문 버튼은 다음 별도 요청으로 HTML을 가져왔다. 화면에 표시된 ‘그물눈’ 그룹의 예문 버튼을 한 번 눌러 확인했다.

```http
POST /verbalTrans/searchTransDic_samples.asp
Content-Type: application/x-www-form-urlencoded

topicWord=目
hanjaSound=목
hanjaMeaning=눈 목
hanjaSubMeaning=그물눈
sampleTextIdxs=15635
bookNos=24,10,2,11,13
wordMeaning=
searchArea=
fromPage=
sampleNumStart=1
sampleLimit=3
```

위 본문은 가독성을 위해 URL 디코딩했다. HTTP 200과 원래 사용자 링크의 문장 예문 1건을 확인했다. 이 구조는 문자만 검색하는 옥편을 넘어 **문자·음·기본 훈·세부 의미별로 문헌 용례를 묶은 데이터**임을 보여준다. 사이트는 아직 자의를 입력하지 않은 문장은 이 검색에 포함되지 않는다고 안내한다.

### 이용 범위

현행 [이용권한 안내](https://hm.cyberseodang.or.kr/verbalTrans/classic_inform.asp?info=1#1)는 책별 앞 10페이지의 전체 학습정보를 무료로 공개하고, 그 이후는 정회원 또는 도서 QR·전자책 링크 등으로 접근하도록 설명한다. QR 링크는 그 링크가 연 범위에서 사용하며 이동이 제한될 수 있다. 검색엔진에 남아 있는 예전 ‘첫 챕터’ 안내와 현재 화면의 안내는 다르다.

이번에 받은 QR 링크와 공개 UI가 제공한 범위만 관찰했다. 위 요청이 동작한다는 사실은 데이터의 앱 내 재배포, 전체 수집, 상업적 이용 또는 안정적인 외부 API 제공을 보장하지 않는다. **한문독해첩경의 이 문자별 데이터에 대한 정식 외부 API 문서는 발견하지 못했다.** 이 데이터를 그대로 공급받으려면 운영기관과 API·라이선스·캐시·AI 입력 범위를 확인하는 경로가 필요하다.

## 3. 같은 기관의 공식 Open API는 별도 서비스

[동양고전종합DB Open API 명세](https://db.cyberseodang.or.kr/front/openapi/OpenApiMain.do)는 문헌 검색 API다.

```text
https://db.cyberseodang.or.kr/front/openapi/sabu.do?query=논어&ipp=1
```

인증키 없이 요청하여 XML 200, 총 4,006건, 첫 문헌 ID `C4` 및 서명·저자·원문 서비스 URL 등을 확인했다. 수치는 조사 시점의 값이다. 원문·번역·역주 등을 검색하는 인자는 있지만, 낱자의 훈음·부수·다의어를 반환하는 옥편 계약은 아니다.

[동양고전종합DB 저작권 안내](https://db.cyberseodang.or.kr/front/about/AboutCopyright.do)는 CC BY-NC-ND 2.0 KR과 영리 이용 시 사전 협의를 안내한다. 이 정책을 별도 서비스인 한문독해첩경에 자동 확대 적용하지 않는다.

## 4. 기본 옥편용 공개 데이터

### libhangul

[공식 `data/hanja/hanja.txt`](https://github.com/libhangul/libhangul/blob/main/data/hanja/hanja.txt)는 `한글:한자:설명` 형식이다. 입력기용 한글→한자 변환 사전이므로 문해에서는 한자→독음·훈음 역색인으로 사용한다. [공식 형식 설명](https://libhangul.github.io/libhangul-doc/git/group__hanjadictionary.html)

파일 자체의 1–26행은 **BSD 3조건 라이선스**다. 라이브러리 전체의 LGPL 안내와 구분해야 한다. 데이터의 저작권 고지·조건·면책 문구를 배포물에 포함하고 저자 이름을 무단 보증·홍보에 사용하지 않는 조건이다.

조사한 파일의 마지막 변경 커밋은 [`3db276b40c0b82f26d4d013d70d380d8baf173e0`](https://github.com/libhangul/libhangul/commit/3db276b40c0b82f26d4d013d70d380d8baf173e0), 변경일은 2023-02-26이다. 원본은 6,452,522바이트이며 SHA-256은 `dd44dcc856cf542b1022d0f39c2e9b9f8805fdcc5923be80f04849ed97ce0996`이다.

원본을 직접 집계하고 Unicode Han 문자 여부도 확인한 결과:

| 항목 | 수 |
| --- | ---: |
| 서로 다른 단일 한자 | 27,552 |
| 한자·독음 레코드 | 28,472 |
| 훈음 설명이 하나라도 있는 한자 | 7,374 |
| 독음만 있고 훈음 설명이 없는 한자 | 20,178 |

따라서 ‘2.7만 자 상세 뜻풀이’로 설명해서는 안 된다. 짧은 훈음 사전이며 어원·고전 용례·문맥별 의미를 완비하지 않는다. 일부 글자는 여러 독음 중 한 독음에만 설명이 있다.

### Unihan

[Unicode 17.0 Unihan 명세](https://www.unicode.org/reports/tr38/)의 공식 배포 파일에서 필요한 필드만 추출하면 된다. 매번 웹 조회 페이지를 호출할 필요가 없다. [Unicode License V3](https://www.unicode.org/license.txt)의 고지 조건을 함께 반영한다.

| 필드 | 앱에서의 역할·한계 |
| --- | --- |
| `kHangul` | 한글 한국음. 출처 표지가 붙으므로 파싱 필요 |
| `kKorean` | Yale 로마자 한국음. 한국어 표시에는 `kHangul` 우선 |
| `kDefinition` | 영어 뜻. 한국어 정식 훈음이나 특정 고전의 확정 의미로 표시하지 않음 |
| `kRSUnicode` | 부수와 나머지 획수. 복수 값·변형 부수 표지 처리 |
| `kTotalStrokes` | 현행 규격의 IRG 기준 총획수. 지역 차이는 `kAlternateTotalStrokes` 참고 |
| `kSemanticVariant` 등 | 관계 종류와 출처를 보존한 관련자 표시. 원문 자동 치환에 사용하지 않음 |
| `kDaeJaweon` | 사전의 위치 정보. 한국어 사전 본문이 아님 |

### 현재 문해 문서에 대한 적용 실험

현재 열린 「太常寺」 문장별 대조 화면의 원문에서 서로 다른 한자 100자를 추출해 libhangul 원본과 로컬 대조했다. **100자 모두 최소 하나의 독음과 비어 있지 않은 훈음 설명이 있었다.** 이것은 현재 문서의 항목 존재율이며, 모든 독음과 문맥 의미가 맞는다는 검증은 아니다.

실제로 `況議謚進宴`의 `謚`는 중요한 반례다.

| 자료 | 관찰 |
| --- | --- |
| libhangul `謚` | ‘시’ 항목에는 설명이 없고, ‘익’ 항목에는 웃음 관련 훈이 있음 |
| libhangul `諡` | ‘시’ 항목에 시호 관련 훈이 있음 |
| Unihan `謚` | 한국음은 익, 영어 뜻은 시호를 주는 의미, `諡`와 의미 이체 관계 |
| Unihan `諡` | 한국음은 시, 영어 뜻은 시호, `謚`와 의미 이체 관계 |

[謚 공식 조회](https://util.unicode.org/UnicodeJsps/character.jsp?a=8B1A), [諡 공식 조회](https://util.unicode.org/UnicodeJsps/character.jsp?a=8AE1).

이 문장에 첫 번째 비어 있지 않은 훈을 자동 대입하면 해석을 오도할 수 있다. 기본 사전 값, 관련자, 해당 문장의 의미 제안을 구분해서 제시하고 원문 표기는 보존해야 한다. `kSemanticVariant`가 있다는 이유로 모든 문맥에서 두 글자를 같다고 처리하지 않는다.

## 5. 실제 사용할 수 있는 외부 사전 API

### 한국어 위키낱말사전

다음 요청은 인증키 없이 실제 성공했다.

```text
https://ko.wiktionary.org/w/api.php?action=parse&page=太&prop=wikitext%7Crevid&format=json&formatversion=2
```

太·常·寺·提·調는 한자풀이 템플릿이 포함된 응답을 받았다. 太의 조회 당시 문서 버전은 `4390578`이었다. 반면 皁와 확장 B 문자 𠀀는 HTTP 200 안에 `missingtitle` 오류가 왔다. 위키만으로 현재 문서의 모든 한자를 채울 수 없다.

정형 옥편 JSON이 아니라 **문서 파싱 API**다. 언어별 구역·템플릿 차이를 처리하고 응답의 오류 객체도 검사해야 한다. 조회한 문서 버전, 출처 URL, 조회일을 남긴다. [API 명세](https://www.mediawiki.org/wiki/API:Parsing_wikitext), [실제 太 항목](https://ko.wiktionary.org/wiki/太)

재사용은 CC BY-SA 4.0의 출처·라이선스·변경 표시 및 동일조건 요건을 반영한다. API 요청에는 식별 가능한 User-Agent와 적절한 캐시·요청 간격을 사용한다. [라이선스](https://foundation.wikimedia.org/wiki/Legal:Text_of_the_Creative_Commons_Attribution-ShareAlike_4.0_International_License/en), [API 사용 지침](https://www.mediawiki.org/wiki/API:Etiquette)

### 국립국어원 표준국어대사전·우리말샘

두 서비스는 정식 API와 XML/JSON을 제공하며 인증키가 필요하다. **한자어의 국어사전 뜻**을 찾기에 적합하다. 아래는 명세에 따른 요청 예시이며 유효한 발급키로 정상 결과까지 검증한 것은 아니다.

```text
https://stdict.korean.go.kr/api/search.do?key=발급키&q=太守&req_type=json&advanced=y&target=2&method=exact
https://opendict.korean.go.kr/api/search?key=발급키&q=太守&req_type=json&advanced=y&target=2&lang=2&method=exact
```

`target=2`는 원어 검색, 우리말샘 `lang=2`는 한자다. 상세 조회는 검색 결과 `target_code`를 이용한다. `守` 포함 검색은 그 글자를 원어에 포함하는 한국어 어휘 검색이므로 `守` 자체의 모든 고전 자의와 같지 않다. 부수·획수·이체자를 완비한 낱자 옥편 응답도 아니다.

[표준국어대사전 명세](https://stdict.korean.go.kr/openapi/openApiInfo.do), [우리말샘 명세](https://opendict.korean.go.kr/service/openApiInfo).

우리말샘 무효 키 요청에서는 HTTP 200 안에 `020 / Unregistered key` 오류가 반환됐다. 호출 한도·요금은 확인하지 않은 숫자로 단정하지 않는다.

기본 텍스트는 CC BY-SA 2.0 KR 조건으로 상업적 이용이 허용된다. 출전이 있는 용례는 원저작자, 이미지·음성 등은 개별 조건이다. 사전의 기본 뜻풀이와 모든 부속 자료를 같은 권리로 취급하지 않는다. [표준국어대사전 정책](https://stdict.korean.go.kr/join/copyrightPolicy.do), [우리말샘 정책](https://opendict.korean.go.kr/service/copyrightPolicy)

## 6. 그 밖의 후보

| 후보 | 조사 결과 |
| --- | --- |
| 네이버 한자사전 | 공개 한자사전 API는 확인하지 못함. 백과사전 검색 API는 다른 서비스 |
| 다음/카카오 | 현행 공개 검색 API 목록에 사전 API가 없음 |
| 한국어문회 | 외부 앱용 낱자 사전 API·재배포 허가를 확인하지 못함 |
| 공공데이터포털·한국학중앙연구원 | 직책·복식·문화유산 용어 및 사전 연결 자료는 있으나 일반 옥편과 다름 |
| CC-CEDICT | 중국어·병음·영어 뜻의 공개 데이터. 한국어 훈음 사전을 대체하지 않음 |
| Hanzi Writer | 필순·획 애니메이션 구현 가능. 뜻풀이 공급원이나 범용 필기 인식 API는 아님 |

네이버 검색 API는 신규 신청 경로와 약관이 변경되었다. 기존 개발자센터의 2026-09-07 시행 검색 API 특약에는 데이터의 AI 입력 금지와 검색 결과 가공·캐시 제한이 있어 문맥 판단 입력으로 추천하지 않는다. 별도 서비스인 NAVER API HUB 전체에 같은 약관을 확대 적용한다는 뜻은 아니다. [이관 안내](https://developers.naver.com/notice/article/32530), [특약 개정](https://developers.naver.com/notice/article/33400), [백과사전 API](https://developers.naver.com/docs/serviceapi/search/encyclopedia/encyclopedia.md), [카카오 검색 API 목록](https://developers.kakao.com/docs/ko/daum-search/common)

[한국학중앙연구원의 직책–사전 연계 자료](https://www.data.go.kr/data/15049062/fileData.do)는 직책명과 조선왕조실록사전 링크를 제공한다. 이런 연결 자료의 이용허락이 링크 대상 사전 본문까지 허가하는 것은 아니다.

[CC-CEDICT 공식 배포](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)는 CC BY-SA 4.0을 안내한다. [Hanzi Writer 문서](https://hanziwriter.org/docs.html)는 로컬 문자 데이터 로딩도 지원한다. 필순 데이터는 코드 라이선스와 별개로 [Arphic Public License 계열 고지](https://github.com/chanind/hanzi-writer/blob/master/COPYING.md)를 보존해야 한다. 한국 고문헌의 희귀자·한국식 필순까지 완비했다고 간주하지 않는다.

## 7. 문해 화면과 데이터 설계

### 조회 화면

1. 기존 선택 → 우클릭 메뉴에 **옥편 보기**를 추가한다. 반복 조회에는 **옥편 모드 → 글자 클릭**을 제공한다.
2. 작은 카드에 글자·음·짧은 훈·다른 음을 먼저 보이고, 상세 패널에서 부수·획수·관련자·출처·용례를 펼친다.
3. 여러 글자를 선택하면 선택한 어휘 전체와 개별 글자 목록을 함께 보여준다. 낱자 뜻을 합쳐 어휘 번역으로 확정하지 않는다.
4. 별도 **독해 보기**를 켜면 글자/어휘 밑에 짧은 뜻을 표시할 수 있다. 기본 훈음, AI 제안, 번역가가 채택한 뜻의 상태를 구분한다. 기존 편집 화면 전체에 항상 축자 카드를 늘어놓을 필요는 없다.
5. AI 문맥 판단은 사용자가 선택한 어려운 부분 또는 다의음·이체자 후보에 집중한다. 사용 가능한 사전 자료, 문장과 앞뒤 문맥, 프로젝트 용어 결정을 함께 전달한다.

### 현재 코드의 접점

| 파일 | 활용·제약 |
| --- | --- |
| `apps/desktop/src/renderer/scripts/editor.ts`의 `sourceSpanMarkup()` | 원문/표점의 원문 좌표 매핑을 활용 |
| `review-selection.ts`, `punctuation-projection.ts` | 표점 화면의 선택을 원문 코드포인트 범위로 복원 |
| `review-comments-ui.ts`의 우클릭 `actions` | 옥편 조회 동작 추가. 조회를 ‘현재 번역 저장 필요’ 조건에 묶지 않음 |
| `review-marks.ts` | 원문 자식 노드를 재생성하므로 상위 이벤트 위임 사용 |
| `quick-term-ui.ts`, `concordance-ui.ts` | 프로젝트 용어 결정·내 번역 용례로 연결 |
| `shared/munhae-api.ts`, preload, `main/ipc.ts`, `main/browser-bridge.ts` | Electron과 localhost에서 같은 조회 계약 제공 |
| `packages/db-sqlite/src/review-comments.ts` | 현재 코멘트는 번역 버전 필수. 번역 전 독해 결정 저장에는 모델 확장 필요 |
| `packages/db-sqlite/src/full-text.ts` | 선택한 코멘트를 재번역 요청에 넣는 기존 경로 활용 |

조회 기능은 원문만 있을 때도 가능해야 한다. 번역 후 해석 결정은 기존 코멘트를 사용할 수 있지만, 번역 전의 원문에도 결정을 남기려면 원문에 독립적으로 연결되는 메모 또는 코멘트 확장이 필요하다. 처음부터 글자마다 프로젝트 DB 행을 생성할 필요는 없다.

데이터는 두 층으로 나눈다.

- 앱 사전: `provider, entryId, headword, readings, senses, radical, strokes, variants, sourceUrl, license, datasetVersion`. 읽기 전용 사전 파일을 앱에 한 번 보관한다.
- 채택한 해석: 문서·원문 버전·범위·인용문·선택한 음/뜻·근거·상태. 실제 결정한 부분만 프로젝트에 저장한다.

`𠮷` 같은 보조평면 문자와 이체자 선택자(IVS)를 보존해야 한다. 화면상 한 글자와 코드포인트 개수가 같지 않을 수 있다. 원문을 NFKC 등으로 자동 변경하지 않고, 조회용 대체 표제어를 별도로 생성한다.

## 8. 구현 순서와 완료 판정

**1차:** libhangul+Unihan 로컬 옥편, 원문/표점 선택 연동, 훈음·부수·획수·이체자, 출처 표시, 한자·독음·부수/획수 검색. API 키 없이 제공 가능하다.

**2차:** 선택한 구절의 문맥 의미 제안, 채택한 뜻 저장, 코멘트·재번역 연결, 독해 보기. 謚/諡와 則의 다의음처럼 기본 훈음만으로 해결되지 않는 사례를 검증한다.

**3차:** 국립국어원 API 키를 통한 한자어 상세 조회, 허용 범위의 추가 사전·용례, 필요한 경우 전통문화연구회 데이터 제휴. 필순은 후순위다.

완료 검증에는 최소한 원문·표점 동일 위치 조회, 반복 글자 위치 구분, 희귀자/IVS 보존, 음만 있는 항목의 정확한 표시, 오프라인 조회, 외부 API의 HTTP 200 오류 처리, 출처 보존, 선택한 해석의 저장·재열기·재번역 반영을 포함한다.
