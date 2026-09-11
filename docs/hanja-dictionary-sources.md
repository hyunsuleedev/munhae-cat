# 문해: 외부 옥편 데이터셋·무료 및 유료 API 조사

조사일: 2026-09-08. [Cyberseodang 기능과 앱 연결 조사](./hanja-dictionary-research.md)에 이어, 다른 공급원의 실제 다운로드 파일·공식 API 문서·사용 조건을 조사했다. 앱 기능은 구현하지 않았다. API 키 발급, 회원가입, 결제, 업체 연락도 하지 않았다.

후속 확인: [한국어 풀이 사전만 좁힌 재조사](./korean-hanja-dictionary-sources.md)에서 e-hanja 공급사의 **실제 DB 공급·라이선스 사업**을 추가 확인했다. 아래의 앱 소개에 근거한 문의 후보 판정보다 구체적인 공급 근거이며, 최신 판본·가격·사용 조건은 여전히 미확인이다.

## 판단

**다운로드 가능한 사전 데이터는 있다. 무료 자료로 오프라인 옥편을 만들 수 있다. 다만 한국어 훈음, 여러 자의, 한국 고문헌 용례를 모두 충족하는 완성형 한국어 옥편 DB의 공개 배포는 이번 조사에서 확인하지 못했다.**

- 기본 한국어 훈음: libhangul. 문자 정보: Unihan.
- 한국어 추가 풀이: 한국어 위키낱말사전의 Kaikki JSONL. 낱자 표제어 5,458자 중 비어 있지 않은 풀이가 추출된 글자는 5,444자이며 누락과 깊이 차이가 있다.
- 상세 중국어 사전: 대만 교육부 수정본의 전체 XLSX. 고전 인용이 있고, 원문을 보존하는 사전 표시 용도에 적합하다.
- 한국어 전문 콘텐츠: e-한자 공급사와 단국대가 구체적인 제휴 문의 후보다. 공개 DB 판매 상품이나 가격이 확인된 것은 아니다.
- 유료 문자사전 데이터 공급을 명시한 해외 후보: Wenlin. 공개 API 후보: Juhe, TianAPI, Oxford.

## 1. 실제 내려받을 수 있는 데이터

| 자료 | 형식·언어 | 확인한 내용 | 비용·이용 조건 | 문해에서의 역할 |
|---|---|---|---|---|
| [libhangul hanja.txt](https://github.com/libhangul/libhangul/blob/main/data/hanja/hanja.txt) | TXT / 한국어 독음·짧은 훈 | 고유 한자 27,552자, 그중 훈이 있는 글자 7,374자 | 무료. 해당 데이터 파일 자체는 BSD 3-Clause | 빠른 기본 훈음. 모든 글자에 상세 뜻이 있는 것은 아님 |
| [Unicode Unihan 17.0](https://www.unicode.org/Public/17.0.0/ucd/) | ZIP 안 TXT / 여러 독음·영어 기본 뜻 | 한국 독음, 부수·획수, 이체 관계, 사전 위치 등 | 무료. [Unicode License V3](https://www.unicode.org/license.txt) | 문자 속성·희귀자 보완. 한국어 상세 옥편 아님 |
| [Kaikki 한국어판 추출본](https://kaikki.org/kowiktionary/rawdata.html) | JSONL.GZ / 한국어 풀이 | 전체 압축 약 25.8 MB. 한자·중국어·한국어의 낱자 항목 합집합 5,458자 | 무료. Wiktionary의 CC BY-SA 조건 | 구조화된 한국어 의미 후보·일부 고전 용례 |
| [대만 교육부 重編國語辭典修訂本](https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/dict_reviseddict_download.html) | ZIP 안 XLSX / 중국어 풀이 | 163,920행. 낱자 행 13,416개, 독음·이체 중복 포함 | 무료. CC BY-ND 3.0 Taiwan, 상업 이용 가능·항목 내용 변경 제한 | 상세 자의·어휘·고전 인용을 원문으로 제시 |
| [대만 교육부 國語小字典](https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/dict_mini_download.html) | ZIP 안 XLSX / 중국어 풀이 | 4,719행 | 무료. CC BY-ND 3.0 Taiwan | 쉬운 기본 설명. 전문 고한문에는 수정본 우선 |
| [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cedict) | TXT.GZ / 번체·간체·병음·영어 뜻 | 현재 파일 헤더 125,025항목 | 무료. 현재 파일 CC BY-SA 4.0 | 낱자와 어휘 보완. 한국어 독음 없음 |
| [cjkvi-dict](https://github.com/cjkvi/cjkvi-dict) | XML / 고전 중국어 | 說文解字注·廣韻 등 | 무료. 프로젝트 GPLv2 고지 | 자원·고전 자의 연구 자료 |
| [CNS11643 全字庫](https://data.gov.tw/dataset/5961/) | ZIP 안 TXT / 문자 속성 | 부수·획수·필순·부품·코드 대응 | 무료. 정부 개방자료/OFL 이용 조건 확인 | 희귀자·자형 보완. 뜻풀이 없음 |
| [한국어문회 배정한자 CSV 변환본](https://github.com/rycont/hanja-grade-dataset) | CSV / 한국어 훈음 | 5,978자. 부수·획수·급수 | 다운로드 무료. 원자료 권리는 한국어문회, 앱 재배포 허가 미확인 | 승인 확보 시 학습용 훈음 보완 |

‘행’, ‘표제어’, ‘고유 한자’, ‘뜻 개수’는 서로 다르다. 표의 숫자를 같은 단위로 비교하면 안 된다.

### 바로 받을 수 있는 파일

- [Unihan 17.0 ZIP](https://www.unicode.org/Public/17.0.0/ucd/Unihan.zip)
- [libhangul 원본 TXT](https://raw.githubusercontent.com/libhangul/libhangul/main/data/hanja/hanja.txt)
- [Kaikki 한국어판 raw JSONL.GZ](https://kaikki.org/kowiktionary/raw-wiktextract-data.jsonl.gz)
- [교육부 수정본 20260625 ZIP](https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/download/dict_revised_2015_20260625.zip)
- [교육부 소자전 20260626 ZIP](https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/download/dict_mini_2019_20260626.zip)
- [CC-CEDICT TXT.GZ](https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz)
- [說文解字注 XML](https://raw.githubusercontent.com/cjkvi/cjkvi-dict/master/swjz.xml), [廣韻 XML](https://raw.githubusercontent.com/cjkvi/cjkvi-dict/master/sbgy.xml)
- [CNS 문자 속성 ZIP](https://www.cns11643.gov.tw/opendata/Properties.zip), [코드 대응표 ZIP](https://www.cns11643.gov.tw/opendata/MapingTables.zip)
- [한국어문회 유래 CSV](https://raw.githubusercontent.com/rycont/hanja-grade-dataset/main/hanja.csv) — 다운로드 가능과 재배포 허가는 구분.

### Kaikki를 직접 파싱한 결과

2026-09-01 위키 덤프를 2026-09-05에 추출한 파일을 받았다. 압축 파일 25,836,438바이트, 전체 356,160 JSONL 행이다. 한국어판 위키의 여러 언어 사전을 함께 담으므로 전체 행 수를 한자 수로 세면 안 된다.

| 원본의 언어 분류 | 한 글자 한자 항목 행 | 고유 글자 | 뜻 항목 |
|---|---:|---:|---:|
| 한자 | 3,996 | 3,890 | 5,156 |
| 중국어 | 3,085 | 2,225 | 5,088 |
| 한국어 | 440 | 402 | 599 |

세 분류의 고유 글자 합집합은 **5,458자**다. 이 중 적어도 하나의 비어 있지 않은 `glosses`가 있는 글자는 **5,444자**다. 계산은 한 코드포인트인 CJK 통합·호환·확장 영역 표제어로 제한했다. IVS가 붙은 자형이나 여러 글자 어휘는 제외된다.

- `寺`에는 절·관청·마을 등의 복수 의미가 있다.
- `常`, `調`, `諡`의 일부 항목에는 한국 고문헌 원문과 번역 예가 있다.
- `目`에는 기본 눈 의미만 확인되어, 사용자가 본 문맥의 그물눈 의미까지 이 자료만으로 해결되지 않는다.
- `謚`, `皁`, `𠀀`은 위 세 분류에서 찾지 못했다.
- `lang=한자`가 `lang_code=unknown`으로 추출된다. `lang_code=ko`만 고르면 한자 항목 상당수를 놓친다.
- 훈음·부수 등이 모든 항목에서 정형 필드로 추출되지는 않는다. JSONL 변환 자체가 완성형 옥편 스키마를 보장하지 않는다.

현재 Kaikki는 예전 post-processed 파일의 폐기 예정도 알린다. 신규 작업은 raw JSONL을 기준으로 하고 판본·원문 URL·출처를 보존하는 편이 적절하다. 재사용 조건은 [Wikimedia 이용약관 7항](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content)을 따른다. 데이터 개작물의 공유 조건을 앱 코드의 라이선스와 혼동하지 않는다.

### 대만 교육부 수정본의 실용성

다운로드 파일은 페이지 스크래핑이 아니라 공식 배포 XLSX다. `太守`의 관직 설명, `目`의 여러 자의와 고전 인용, `謚`의 별도 독음 및 `諡` 이체 참조를 실제 확인했다. `諡`는 사후 칭호와 그 칭호를 부여하는 행위를 구별한다. 일반 훈음표보다 전문 번역의 사전 근거로 유용하다.

주요 열은 표제어, 별명, 항목번호, 부수, 총획수, 부수 외 획수, 복수 독음 순서, 주음, 병음, 유의어·반의어, 뜻풀이, 독음 참조, 이체자다. 한국어 훈음은 없으므로 별도 자료와 연결해야 한다.

[공식 이용 설명](https://language.moe.gov.tw/001/Upload/Files/site_content/M0001/respub/reviseddict_10312.pdf)은 상업 이용을 허용하되 항목의 뜻·독음·자형 등을 바꾸거나 간체로 변환하지 않도록 명시한다. 내용 자체를 바꾸지 않는 조정은 별도로 설명한다. 원문 보존·검색 인덱싱과 한국어 번역 사전 재배포는 구분해야 한다. AI가 재작성한 풀이를 배포하는 권리까지 자동으로 확보된다고 판단하지 않는다.

### 그 밖의 파일 검증

- CC-CEDICT: 압축 3,973,063바이트, 125,025항목. 파일 헤더는 **CC BY-SA 4.0**이며 예전 [프로젝트 위키](https://cc-cedict.org/wiki/)의 3.0 표기와 다르다. 현재 파일을 기준으로 라이선스를 기록한다. `目`의 그물눈 의미와 `太守` 항목을 확인했다.
- 說文解字注: XML 6,219,586바이트. `<shuowen>` 9,426개, `<wordhead>` 11,246개. 이 태그 수는 현대 옥편의 고유 표제자 수와 같지 않다. `kx2ucs.txt`는 **강희자전 전문이 아니라 번호와 Unicode 대응표**다.
- CNS Properties: ZIP 3,158,491바이트. 획수 97,361행, 부수 97,291행, 필순 94,919행. 뜻풀이를 채우는 자료로 사용하지 않는다. [공식 라이선스 설명](https://www.cns11643.gov.tw/pageView.jsp?ID=59&SN=&la=0&lang=tw)
- 배정한자 CSV: 317,113바이트, 5,978행·고유자. `謚`에 익/시의 훈음이 함께 있어 기본 훈음 자료 간 차이도 확인했다. 공식 XLS는 사이트 접속 오류로 다운로드하지 못했다. [공식 기타자료 게시판](https://www.hanja.re.kr/kccpt/exam/otherData.do), [이용약관](https://www.hanja.re.kr/main/terms.do)과 개별 허가 확인이 남는다.

## 2. 한국어 상세 옥편의 유료·제휴 공급 후보

| 후보 | 공식적으로 확인한 사실 | 아직 확인하지 못한 것 |
|---|---|---|
| **오픈마인드지앤에이 / e-한자** | [개발자 공식 앱 설명](https://play.google.com/store/apps/details?hl=ko&id=kr.openmindgna.ehanjab)에 표제자 8,913자, 용례단어 약 7.4만, 네이버 한자사전 콘텐츠 제공을 명시 | 제3자에게 판매하는 DB 상품·API 명세·가격·AI 이용 범위 |
| **단국대 동양학연구원** | [공식 검색시스템 소개](https://www.dankook.ac.kr/web/-oriental/-115): 한국한자어사전·이두사전·한국한자자전을 DB화해 무료 웹 서비스 | 공개 전체 덤프·외부 API·상용 재배포 계약·가격 |
| 민중서림·동아·교학사·다락원·한컴 | 옥편·전자사전 관련 출판·제품 존재와 별개로 조사 | 일반 개발자 대상의 현재 DB/API 판매 상품은 이번 조사에서 공식 확인하지 못함 |

e-한자는 **사전 콘텐츠의 외부 공급 실적이 확인되는 문의 후보**다. 개인용 앱을 구매하면 콘텐츠를 다른 앱에 넣어도 된다는 뜻은 아니다.

단국대는 한국 고문헌에서 쓰인 한자어·이두 자료라는 점에서 문해와 관련성이 높다. [실제 검색시스템](https://oriental-dic.dankook.ac.kr/)은 한국식 한자 표제어 약 8.5만 건과 용례 약 7.4만 건 등을 안내한다. 이를 『한한대사전』 전체 데이터의 개방이라고 표현하면 안 된다. [공식 담당부서](https://www.dankook.ac.kr/web/-oriental/-11)에 네이버 사전 웹서비스 및 자체 검색시스템 관리 업무가 명시되어 있다.

제휴 검토 때는 필요한 범위를 구체적으로 제시한다: 앱 안에서 원문 사전 표시, 오프라인 파일 탑재, 사용자 해석 기록에 인용 저장, 외부 LLM에 근거로 전달, 사전 풀이의 한국어 재작성·번역 허용 여부. 업체에 메시지를 보내지는 않았다.

## 3. 다른 유료 데이터·무료 및 유료 API

가격은 2026-09-08 공식 페이지 표시 기준이다. 무료 할당량도 대체로 계정과 키가 필요하며 정상 키를 사용한 API 응답은 이번 조사에서 시험하지 않았다.

| 공급원 | 제공 내용 | 무료·유료 | 도입 판단 |
|---|---|---|---|
| [Wenlin 개발자 라이선스](https://wenlin.com/developers) | 문자사전 Zidian 67,000+ 항목, ABC 중영사전 200,000+ 항목 등 데이터 공급 | 공개 정가 없음, 개별 견적 | **유료 사전 원본 공급을 명시한 후보.** 한국어 훈음 없음. 파일 형식·오프라인·AI 범위는 계약 필요 |
| [Juhe 新华字典](https://www.juhe.cn/docs/api/id/156) | 한자·병음·부수·획수·간략/상세 풀이 JSON | [무료 50회/일](https://www.juhe.cn/docs/c6), [유료 회원 확장](https://www.juhe.cn/vip) | 중국어 자의·고전 인용 보조. 한국어 옥편 대체 아님 |
| [TianAPI 中文词典](https://www.tianapi.com/apiview/48) | 중국어 어휘의 풀이·출전 JSON | 무료 100회/일. 고급 회원 CNY 29/월 또는 169/년, 1만 회/일 | 저렴한 어휘 보조 API. 낱자 부수·획수용 사전과 다름 |
| [Oxford Dictionaries](https://developer.oxforddictionaries.com/) | 중국어 단일언어·중영 사전 JSON | Sandbox 500회. Enterprise 언어당 연 GBP 5,000부터 | 현대 중국어 중심. 일반 API 약관상 AI 입력 금지, 별도 AI 계약 필요 |
| [국립국어원 우리말샘](https://opendict.korean.go.kr/service/openApiInfo) / [표준국어대사전](https://stdict.korean.go.kr/openapi/openApiInfo.do) | 한국어 단어 정의, 한자 원어 검색 | 무료 API, 발급 키 필요 | 한국어 한자어에 유용. 단일 한자 전체 자의·자원 사전은 아님 |

Wenlin은 Pleco·Hanping 등 외부 업체와의 데이터 라이선스 관계도 공개한다. 개발자용 데이터 공급과 개인용 사전 프로그램 구입을 구분하는 데 도움이 된다. 견적형이므로 비용을 임의로 추정하지 않는다.

Juhe 회원 페이지는 연 CNY 1,299의 1만 회/일, 연 CNY 3,999의 무제한 등 확장 상품을 안내한다. 개별 API 제한과 실제 신청 화면이 우선한다. [이용약관](https://www.juhe.cn/legal?f=footer)은 약정 범위를 벗어난 재배포·재판매 등을 제한하므로 API 결과를 모아 앱 동봉 DB로 재배포할 권리를 별도로 확인한다.

TianAPI의 `content`는 긴 설명 문자열이다. 항목별 의미·시대·출전이 항상 별도 정형 필드로 제공되는 것은 아니다. [OpenAPI 3 문서](https://www.tianapi.com/openapi/lexicon.json)는 공개되어 있다.

Oxford는 [중국어 API 추가 공지](https://languages.oup.com/about-us/annual-updates/oxford-dictionaries-api-2024/)가 있고, [FAQ](https://developer.oxforddictionaries.com/faq)는 오프라인 저장을 Enterprise에 한정한다. [약관 6.1.1](https://developer.oxforddictionaries.com/api-terms-and-conditions)은 AI prompt·grounding을 포함한 사용을 제한한다. 일반 API 계약과 별도 AI 라이선스를 구분해야 한다.

### 문서에 명시된 요청 형태

아래의 키는 자리표시자다. 유효한 키를 사용해 성공 응답을 검증한 요청은 아니다.

```http
GET https://v.juhe.cn/xhzd/query?key=ISSUED_KEY&word=目
GET https://apis.tianapi.com/lexicon/index?key=ISSUED_KEY&word=太守
GET https://stdict.korean.go.kr/api/search.do?key=ISSUED_KEY&q=太守&req_type=json&advanced=y&target=2&method=exact
GET https://opendict.korean.go.kr/api/search?key=ISSUED_KEY&q=太守&req_type=json&advanced=y&target=2&lang=2&method=exact
```

Juhe의 `jijie`, `xiangjie`가 간략·상세 풀이이며 TianAPI는 `word`, `content`를 반환한다. Juhe의 [공식 명세 PDF](https://www.juhe.cn/docs/download/pdf/156)에서 필드와 예시를 확인했다.

### 구매 후 파일을 내려받는 별도 상품

[Juhe 成语大全](https://www.juhe.cn/market/product/id/10257)은 약 4.4만 성어의 풀이·독음·유의어·반의어를 **XLSX 약 7 MB, CNY 499**에 판매한다. 게시된 파일은 2021년 배포판이며 일부 필드 누락 가능성이 명시돼 있다. 옥편 전체가 아닌 성어 보조 자료다. 상품 페이지는 확인했지만 결제·파일 다운로드·현재 결제 가능 여부는 검증하지 않았다. 앱 원본 동봉 권리가 가격에 포함되는지도 확인이 필요하다.

## 4. 이름만 보고 채택하면 안 되는 후보

| 후보 | 확인 결과 |
|---|---|
| [HanjaDict Python](https://github.com/seyoungsong/hanjadict), [JS](https://github.com/seyoungsong/hanjadict-js) | 예전 배포·검색 결과의 대규모 한자 DB 소개와 달리 현재 저장소는 **데이터 미포함**, 사용자 제공 테이블을 요구한다. MIT는 코드에만 적용한다고 명시 |
| [한국어문회 CSV](https://github.com/rycont/hanja-grade-dataset) | 공개 GitHub 파일이라고 자유 재배포 데이터가 아님. README가 원자료 권리를 한국어문회에 귀속 |
| [漢典 ZDIC](https://zdic.net/terms/) | 현행 약관은 CC0를 선언하지만 외부 현대 사전·교육부 BY-ND 데이터 등을 원천으로 명시한다. 전체 덤프·공식 API 미확인. 제3자 원천 권리와 공급 조건 별도 확인 |
| [CTP API](https://ctext.org/tools/api/ens) | `getcharacter?char=目`는 실제 200이지만 뜻풀이 없이 문자 속성과 사전 링크 반환. `getdictionaryheadwords`도 표제어 목록임 |
| [대만 교육부 異體字字典](https://dict.variants.moe.edu.tw/page.jsp?ID=6) | 무료 웹 사전과 전체 파일 개방은 다름. 수정본 등 네 사전의 공개 라이선스를 이 사이트 전체에 확대 적용하지 않음 |
| [JisuAPI 新华字典](https://www.jisuapi.com/api/zidian/) | 문서는 남아 있으나 공식 페이지가 서비스 내려감(`接口已下架`) 표시. 신규 도입 추천에서 제외 |
| [Collins API 신청](https://blog.collinsdictionary.com/collins-api-apply-for-a-key/) | 현재 신청 목록에 중국어·한국어 없음. 웹 사전에 해당 언어가 있다고 API 지원으로 간주하면 안 됨 |
| [WiktAPI](https://wiktapi.dev/quickstart) | 공개 코드로 Kaikki를 SQLite/API로 구성 가능. 공개 호스팅 시험은 404/403으로 정상 조회 미검증 |
| [WFG 康熙字典](https://fgwang.blogspot.com/2018/12/blog-post_10.html) | 제작자 배포 ZIP 링크와 CC BY-SA 3.0 고지 확인. 파일 내용은 받지 않았고, 제작자도 추가 독음 교정 필요를 밝힘. 후속 검증 후보 |
| [Hanjaro credits](https://hanjaro.com/en/credits) | 별도 학습 사이트가 편집 데이터의 CC BY-SA 4.0을 선언하나 어문회 등 원천 권리와 실제 전체 배포 파일은 별도 확인 필요 |

한국어 사전으로 검색되는 인명한자 목록·급수표·Naver 크롤링 결과를 ‘상세 옥편 전체’라고 묶지 않는다. 데이터 수량이 많아도 대표 음만 있거나 출처 재배포 허가가 없을 수 있다.

## 5. 문해에 권하는 도입 순서

1. **오프라인 기본 조회:** libhangul + Unihan. 출처별 독음·뜻을 보존하고 없는 뜻을 있는 것처럼 채우지 않는다.
2. **추가 의미 후보:** Kaikki 한국어판. 내용과 추출 품질을 점검한 항목부터 사용하며, 공동편집 사전임을 표시한다.
3. **전문 사전 근거:** 교육부 수정본을 중국어 원문 그대로 검색·표시하는 사전 팩을 검토한다. 출처 원문, 번역가의 해석 결정, AI 제안을 분리한다. 한국어로 개작한 사전 배포나 AI 이용 범위는 따로 판단한다.
4. **한국어 상세 사전 확장:** e-한자와 단국대의 제공 가능 데이터·계약 범위를 먼저 확인한다. 중국어 API는 보조 공급원으로 평가한다.

문해의 기존 코멘트·재번역 흐름에는 사용자가 채택한 문맥의 뜻과 사전 출처를 연결할 수 있다. 사전의 첫 번째 뜻을 문맥 정답으로 자동 확정해서는 안 된다. 각 데이터셋을 하나의 출처 없는 풀이로 합치는 것보다, 사전별 의미를 비교할 수 있게 유지하는 편이 전문 번역에 적합하다.

## 검증 기록

- 실파일 다운로드·파싱: Kaikki, 교육부 수정본/소자전, CC-CEDICT, 說文解字注, CNS 속성, 배정한자 CSV. libhangul은 앞선 동일 조사에서 실파일 검증.
- 현재 판본의 Unihan ZIP 링크는 Unicode 공식 디렉터리에서 확인. 이번 확장 조사에서 ZIP 전체를 새로 파싱하지는 않았다.
- Kaikki SHA-256: `ae0872f93f01d181b1c6c844e0fde5e7e3ff17a3ec2a9ee18bc4551c2452d369`.
- 교육부 수정본 ZIP: 30,614,978바이트. 소자전 ZIP: 1,139,258바이트.
- 인증 없는 CTP `getcharacter` 정상 응답과 [capabilities](https://api.ctext.org/getcapabilities) 확인. 상세 뜻풀이 API라고 볼 근거 없음.
- 유료 API: 공식 명세·가격·공개 예시 확인. 유효 키를 이용한 정상 응답, 실제 과금, SLA, 한국에서의 가입 절차는 미검증.
- 공개 데이터는 연구용 임시 경로에서 검사했고 사전 전체를 저장소나 앱 배포물에 추가하지 않았다.
