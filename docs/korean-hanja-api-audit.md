# 한국어 옥편·고문헌 사전 API 상세 조사

조사일: 2026-09-08. 네이버·e-hanja·다음·단국대·존한자·KOSTMA·국립국어원과 다운로드 자료를 비교했다. 한국어로 설명하는 자의·어휘 뜻풀이가 대상이다. 일반 공개 페이지의 소량 조회, 실제 브라우저 요청 관찰, 공식 명세·공급 안내 확인을 수행했다. 회원가입·API 키 발급·업체 연락·구매·앱 구현은 하지 않았다.

## 결론

- 네이버 한자사전에는 **작동하는 내부 JSON 검색·상세 요청**이 있다. 그러나 **현재 Developers·APIHUB의 공개 상품 목록과 명세에서 외부 개발자용 옥편 API는 확인하지 못했다.** 비공개 제휴 상품의 존재 여부까지 부정하지 않는다.
- **e-hanja는 실제 DB 라이선스 공급사**다. 한국어 상세 옥편을 앱에 탑재할 경우 가장 구체적인 공급 후보다. 공개 셀프서비스 REST API·납품 파일·B2B 가격은 미확인이다.
- **국립국어원은 정식 API와 사전 다운로드 경로가 확인된다.** 주 용도는 한국어 한자어 뜻풀이이며, 모든 한자의 고전 자의를 설명하는 옥편과 범위가 다르다.
- **단국대는 한국 고문헌 어휘·출전**, **KOSTMA는 역사 용어의 조회 위젯·해설 연결**에 유용하다.
- 웹페이지 내부 요청의 성공, 공개 API 제공, 데이터 재배포 허락, 외부 AI로 전달할 권한은 각각 별도로 확인해야 한다.

## 1. 네이버 한자사전

### 공식 외부 API

현재 [Developers 상품 목록](https://developers.naver.com/products/intro/plan/plan.md), [APIHUB Application 목록](https://guide.ncloud-docs.com/docs/apihub-application), [API 명세 목록](https://api.ncloud-docs.com/docs/naver-api-hub-overview)을 대조했다. 한자사전·옥편 API는 확인되지 않았다.

목록에 있는 **백과사전 검색 API는 다른 상품**이다. [공식 백과사전 명세](https://api.ncloud-docs.com/docs/naver-api-hub-search-encyc)는 다음을 제공한다.

```text
GET https://naverapihub.apigw.ntruss.com/search/v1/encyc
    ?query=검색어&display=10&start=1&format=json
```

인증 헤더는 `X-NCP-APIGW-API-KEY-ID`, `X-NCP-APIGW-API-KEY`다. 결과는 `title`, `link`, `description`, `thumbnail`이며, 설명은 백과 항목의 요약이다. 한자의 독음·부수·획수·자의 목록을 제공하는 사전 스키마가 아니다. 키를 발급받아 호출하지는 않았다.

[이관 공지](https://developers.naver.com/notice/article/32530)에 따르면 2026-07-31부터 해당 검색 API의 신규 신청은 APIHUB에서 받는다. 기존 Developers 신청자는 2027-06-30까지 유예된다. [현재 APIHUB 운영 안내](https://guide.ncloud-docs.com/docs/apihub-overview)는 한시적 무료, 검색 합산 월 775,000건, 키당 50 RPS를 안내한다. 개별 백과사전 명세에는 일 25,000회 문구도 남아 있어 문서 간 차이가 있다. 이 수치들은 옥편 API의 요금이나 한도가 아니다.

### 실제 브라우저 요청

별도의 로그인 없는 새 Playwright 브라우저에서 [네이버 한자사전](https://hanja.dict.naver.com/)의 검색창을 조작했다. `目`, `謚`, `太守`, `提調` 검색과 `目` 상세 페이지를 확인했다. 웹 수집 도구에서는 로봇 제한이 있었지만 일반 브라우저 페이지는 정상 동작했다.

검색 요청:

```text
GET https://hanja.dict.naver.com/api3/ccko/search
    ?query=目&m=pc&hid=<브라우저가 붙인 값>
```

상세 요청:

```text
GET https://hanja.dict.naver.com/api/platform/ccko/entry
    ?entryId=9969e350b6674531aced9c79c843b839
    &isConjsShowTTS=true&searchResult=false&hid=<브라우저가 붙인 값>
```

실제 전송 시 한자는 URL 인코딩된다. `hid`의 의미·필수 여부는 검증하지 않았다. 위 주소는 관찰한 내부 요청이며, 공식 통합용 명세가 아니다.

| 단계 | 실제 응답 구조 | 확인 결과 |
|---|---|---|
| 검색 | `searchResultMap.searchResultListMap.LETTER/WORD` | 낱자와 어휘를 별도 묶음으로 반환 |
| 검색 항목 | `entryId`, `expKoreanPron`, `meansCollector[].means`, `sourceDictnameKO` | 독음·뜻 미리보기·제공사·상세 식별자 |
| 상세 | `entry.means[]`, `radical`, `stroke_cnt`, `members`, `relateds` 등 | 상세 자의·부수·획수·관련 정보 |
| 제공사 | 검색의 `sourceDictnameKO`, 상세의 `entrySource.sourceDicts[].dict_name` | 표본의 e-hanja 출처를 화면과 대조 |

`目`는 검색에서 뜻 3개, 상세에서 **15개 자의**를 반환했다. 검색 결과만 사용하는 구현은 이 사례에서 나머지 뜻을 놓친다. [실제 目 상세](https://hanja.dict.naver.com/#/entry/ccko/9969e350b6674531aced9c79c843b839)

| 검색어 | 낱자 검색 건수 | 단어·성어 검색 건수 | 확인 사항 |
|---|---:|---:|---|
| 目 | 1 | 988 | 낱자 상세에 자의 15개. 단어·성어 건수는 자의 개수가 아님 |
| 謚 | 1 | 0 | 훈음에 익·시 둘 다 표시 |
| 太守 | 2 | 7 | 太·守 낱자와 太守 어휘를 별도로 반환. 일부 결과는 단국대 출처 |
| 提調 | 2 | 37 | 提·調 낱자와 提調 및 복합 관직명을 별도로 반환 |

내부 JSON의 모든 필드 이름을 그대로 신뢰해서도 안 된다. `目` 상세에서 상위 `entrySource.source_name`은 화면과 다른 사전명을 담았고, 하위 `sourceDicts[].dict_name`은 화면의 e-hanja 출처와 일치했다. 상위 필드의 의미는 미확인이다.

추가로 Python urllib 기본 요청에서 쿠키·추가 헤더·`hid` 없이 검색 주소를 호출했을 때 **HTTP 200이지만 본문은 0바이트**였다. 단순 서버 호출의 성공은 확인되지 않았다. 원인은 확정하지 않았고 토큰 복제나 접근 제한 우회는 시도하지 않았다.

최소 검증 기록: [naver-observations.json](../output/playwright/hanja-api-audit/naver-observations.json). 전체 사전 본문 대신 표본의 구조·개수·출처만 정리했다.

### 콘텐츠 이용

[네이버 사전 고객센터](https://help.naver.com/service/5609/contents/19816?lang=ko&osType=PC)는 페이지의 자료제공을 확인하고 콘텐츠 사용 가능 여부를 해당 저작권자에게 확인하도록 안내한다. [콘텐츠 제휴 안내](https://help.naver.com/service/5609/contents/19817?lang=ko&osType=PC)는 일반 제휴 창구이며 공개 옥편 API 상품을 보장하는 페이지가 아니다.

[APIHUB 약관 페이지](https://www.ncloud.com/policy/terms/opapi)가 연결한 AI·NAVER API 서비스 이용약관도 허용 범위를 넘은 복제·저장·가공·배포·제3자 제공을 제한한다. 공개 API 키가 사전 DB 탑재나 외부 AI 입력 권한을 자동으로 제공한다는 근거는 없다. AI 이용을 전면 금지한다고 확대 해석하지도 않는다.

**판단:** 내부 요청의 존재는 확인했다. 제품 통합은 원 제공사의 DB 공급 조건을 확인하는 경로가 더 구체적이다. 네이버 사전 전체를 e-hanja 단일 출처로 간주하면 안 된다.

## 2. e-hanja / 오픈마인드

[공식 공급사 사이트](http://www.openmindinfo.kr/)는 한자 DB 공급·라이선스 사업을 명시하며 네이버·다음·네이트·디오텍·윤디자인 공급 이력을 안내한다. 제품 설명은 **71,280자·약 18만 어휘**다. 다만 페이지의 마지막 연혁은 2020년이며 Unicode 10.0을 언급하므로 현재 납품 판본의 실측 수록량으로 취급하지 않는다.

[현재 개인용 앱](https://play.google.com/store/apps/details?id=kr.openmindgna.ehanjab&hl=ko)의 8,913자·약 74,000단어는 별도 제품이다. 웹 DB 전체의 크기와 혼동하지 않는다. 개인 웹 이용료 1개월 10,000원·3개월 25,000원·6개월 40,000원도 B2B DB 공급 가격이 아니다.

대표 네 항목의 본문을 로그인 없이 실제 확인했다.

| 표본 | 실제 내용 |
|---|---|
| [目](http://www.e-hanja.kr/e-hanja/dic/contents/jajun_content.asp?hanja=%E7%9B%AE) | 자의 15개, 자원·부수·획수·이체자·관련어 |
| [謚](http://www.e-hanja.kr/e-hanja/dic/contents/jajun_content.asp?hanja=%E8%AC%9A) | 익/시 독음을 나누어 웃음·시호 관련 의미를 구분 |
| [太守](http://www.e-hanja.kr/e-hanja/dic/contents/word_conABC.asp?word=%E5%A4%AA%E5%AE%88) | 신라 관직·지방 행정 책임자·중국 관직의 세 설명과 용례 |
| [提調](http://www.e-hanja.kr/e-hanja/dic/contents/word_conABC.asp?word=%E6%8F%90%E8%AA%BF) | 조선 관직 설명, 관련어, 『오례의』·번역 『문종실록』 등 출처가 붙은 예문 |

공개 상세페이지가 사용하는 실제 요청은 HTML 조각이다.

```text
POST http://www.e-hanja.kr/e-hanja/dic/contents/jajun_contentA.asp
hanja=目&qry=&snd=&pageNo=&keyfield=&keyword=&hanjaGrade=&backUrl=

POST http://www.e-hanja.kr/e-hanja/dic/contents/word_conABCA.asp
keyword=太守&word=太守&backUrl=&id=
```

네 표본은 HTTP 200으로 본문을 반환했다. 부모 페이지의 공통 유료 안내 모달만으로 본문 접근이 모두 차단됐다고 판단하면 부정확하다. HTTPS 접속은 실패했으나 HTTP는 정상인 경로가 있었다.

**확인된 것:** 상세 한국어 옥편의 실물과 실제 DB 공급 사업. **미확인:** 최신 납품판, 공개 API, JSON/SQLite/SDK 등 납품 형식, B2B 가격, 오프라인 앱 재배포·캐시·외부 AI 입력·학습 권리. 공식 문의처는 `webmaster@openmindinfo.kr`, `031-757-6504`이며 연락하지 않았다. 회사 사이트와 개인 앱의 법인 명의가 달라 계약 주체도 확인 대상이다.

## 3. Daum 한자사전

[현재 目 상세](https://dic.daum.net/word/view.do?wordid=hhw000006614&supid=hhu000006617)는 **금성출판사 『뉴에이스 한한사전』**을 출처로 표시한다. 소개 규모는 한자 약 14,000자·숙어 약 50,000개다. e-hanja의 2005년 다음 공급 이력만으로 현재 Daum 전체가 e-hanja라고 설명하면 틀린다.

```text
GET https://dic.daum.net/search.do?q=謚&dic=hanja
GET https://dic.daum.net/search.do?q=太守&dic=hanja
GET https://dic.daum.net/search.do?q=提調&dic=hanja
```

실제 HTML에서 謚의 독음·자의, 太守·提調의 낱자와 어휘 결과를 확인했다. [Kakao Developers의 Daum 검색 명세](https://developers.kakao.com/docs/ko/daum-search/dev-guide)는 웹·동영상·이미지·블로그·책·카페 검색 API를 안내하며 한자사전 API는 포함하지 않는다. 검색 요약·URL 반환을 사전 DB 공급으로 해석하지 않는다.

현재 사전 footer와 연결된 [회사 페이지](https://daumcorp.com/)는 주식회사 다음을 표시한다. 과거 Kakao·AXZ 설명을 현재 운영사 정보로 그대로 인용하지 않는다. **판단:** 외부 사전 열람 후보. 공개 옥편 API·DB 다운로드·납품 가격은 미확인이다.

## 4. 단국대 한국한자 종합검색시스템

[현재 서비스](https://oriental-dic.dankook.ac.kr/)는 『한국한자어사전』·『한국한자자전』·『이두사전』이다. **『한한대사전』 전체 54,000자·42만 어휘가 현재 공개되어 있다는 뜻은 아니다.**

공식 도움말에 기재된 웹 서비스 수록량:

| 사전 | 웹 수록량 | 주 용도 |
|---|---|---|
| [한국한자어사전](https://oriental-dic.dankook.ac.kr/etc/help?type=hanjaeo) | 표제자 548자·어휘 80,657개 | 한국 고문헌 어휘·뜻·출전·예문 |
| [한국한자자전](https://oriental-dic.dankook.ac.kr/etc/help?type=hanjajun) | 표제자 3,724자·용례 5,626개 | 한국 고유 자형·음·뜻·이체 관계 |
| [이두사전](https://oriental-dic.dankook.ac.kr/etc/help?type=idu) | 이두 4,237개·용례 12,208개 | 독음·현대어 풀이·형태소 분석·용례 |

한국한자어사전 책의 표제자 5,174자·어휘 89,705개는 웹 수치와 다르다. 위 숫자는 도움말 표기이며 전체 DB를 내려받아 센 것이 아니다.

실제 일치 검색에서 표제자 `目`·`謚`는 0건, 표제어휘 `太守`는 4건, `提調`는 34건이었다. ‘일치’ 설정에도 복합어가 함께 나왔으며 정확한 `提調` 항목은 목록 24번째였다. 앱에서 결과를 사용할 경우 완전 일치 표제어를 별도로 우선해야 한다.

```text
GET /search/group?q=opExt†N$opStype†VCIN$query†提調

GET /hanjaeo/node?itemId=hanjaeo&gubun=vocainfo
    &depth=&upPath=I^제조&dataId=HH_01556_V023
```

`PJIN/PJMN/PJEX`는 표제자/뜻풀이/용례, `VCIN/VCMN/VCEX`는 표제어휘/뜻풀이/용례다. 실제 전송은 URL 인코딩하며 `/node`는 내부 HTML 요청이다.

[提調 실제 항목](https://oriental-dic.dankook.ac.kr/hanjaeo/item#node?itemId=hanjaeo&gubun=vocainfo&depth=&upPath=I%5E%EC%A0%9C%EC%A1%B0&dataId=HH_01556_V023)은 동사적 뜻과 관직 뜻을 구분하고 『고려사』·『경국대전주해』·실록 등의 예문을 제공한다. 일부 본문에는 설명 중복도 있어 단순 HTML 추출 결과를 곧바로 정제된 DB로 취급하지 않는다.

**판단:** 한국 고문헌 번역에 높은 관련성. 공개 개발자 API·전체 파일 다운로드·앱 재배포 가격은 미확인이다. 사전 문의처 `oriental-dic@dankook.ac.kr`, 저작권 고지는 All Rights Reserved다.

## 5. 존한자사전

[존한자사전](http://www.zonmal.com/)은 한자의 독음·부수·획수·여러 한국어 뜻을 제공한다. 실제 요청:

```text
GET http://www.zonmal.com/hanja_sen.asp?se=目謚太守提調
```

위 GET 요청을 CP949 인코딩으로 실행해 정상 반환을 확인했다. 홈페이지 검색 폼은 같은 경로에 POST를 사용하지만 POST 자체의 성공을 별도로 검증하지는 않았다. **문자열을 낱자로 분해해 조회**하므로 太守를 입력해도 太守라는 관직의 설명이 아니라 太와 守의 뜻이 나온다.

- 目는 시각·관찰·조목·제목·그물코 등 여러 의미를 제공했다.
- 謚는 익과 웃음 관련 풀이가 나왔고, 諡를 별도로 조회하면 시호 관련 풀이가 나왔다.
- `ref_word.asp?ja=太`, `ref_word.asp?ja=提`의 관련어 목록에서는 각각 太守·提調를 찾지 못했다.

실제 원문 `議謚`처럼 자형·독음·문맥을 함께 판단해야 하는 사례에서 단일 훈의 자동 채택은 위험하다. [諡 조회](http://www.zonmal.com/hanja_sen.asp?se=%E3%CD)

**판단:** 일반 자의 열람용. 공식 API·전체 다운로드·DB 공급 조건은 미확인이며 All Rights Reserved 표시가 있다.

## 6. KOSTMA 고문헌용어용례사전

이 서비스는 **문서화된 XML API, 공식 외부 위젯, 상세 본문 HTML**을 구분해야 한다.

[공식 XML API 안내](https://kostma.aks.ac.kr/OpenAPI/HowTo/howTo.aspx?SideMenu=ServiceAPI&Body=DIC):

```text
GET https://kostma.aks.ac.kr/api/API_dicWordListY.aspx?xsl=no&clsCode=A
GET https://kostma.aks.ac.kr/api/API_dicViewY.aspx?searchid=DIC_B1_000762
```

실제 XML은 한글·한자 항목명, 출처, 본문 페이지 URL을 반환했다. **확인한 이 함수에는 상세 뜻풀이 본문이 없다.**

그러나 [현재 공식 위젯 안내](https://kostma.aks.ac.kr/OpenUI/guide_dicOpenUI.html)는 외부 홈페이지에 동일 위젯 또는 자체 위젯을 만들 수 있다고 명시한다. 정상 경로는 `/OpenUI/script/DicOpenUI.js` → `/dicWidget/dicWidget.html`이다.

위젯에서 확인한 검색 요청:

```text
GET https://kostma.aks.ac.kr/dataSearch/dataSearchAjax.aspx
    ?callback=resultDic&cateQ=dic&mT=B&query=太守&queryT=太守
```

`mT=B`는 고문헌용어용례사전이다. 응답은 순수 JSON이 아니라 `var resultDic = {...}` 형태이며 `totalCount`, `resultHtml`을 담는다. UI 삽입용 요약·항목 HTML이며 별도의 버전 API 계약은 확인되지 않았다.

| 검색어 | 건수 | 내용 |
|---|---:|---|
| 目 | 18 | 계목·고목 등 포함 어휘. 目의 자의 18개라는 뜻이 아님 |
| 謚 | 3 | 諡狀·贈諡·諡號 반환. 다른 자형으로 확대된 결과 |
| 太守 | 1 | 신라 지방관직 중심의 설명 |
| 提調 | 3 | 부제조·제조·도제조 |

[태수 본문](https://kostma.aks.ac.kr/dic/dicViewY.aspx?searchid=DIC_BC_000042)과 [제조 본문](https://kostma.aks.ac.kr/dic/dicViewY.aspx?searchid=DIC_B9_000644)을 실제 확인했다. 제조에는 한국민족문화대백과사전과 『역주 경국대전—번역편』의 서로 다른 출처가 함께 있다.

검색되는 구형 안내의 `/openapi/dic/js/dicOpenUI.js`는 404였고 `archive.aks.ac.kr` 일부 요청은 차단됐다. 위에 적은 현재 KOSTMA 경로는 정상이다.

**판단:** 공식 외부 조회 위젯·본문 링크 연결 후보. 전체 본문 DB 다운로드·앱 재배포·외부 AI의 지속적 이용 권리는 별도로 확인되지 않았다. 'API에 본문 없음'을 '사이트에서 본문을 볼 수 없음'으로 확대하면 틀린다.

## 7. 국립국어원: 우리말샘·표준국어대사전

[우리말샘 공식 명세](https://opendict.korean.go.kr/service/openApiInfo)에는 한자 원어 검색이 있다. 한글 독음으로 먼저 변환할 필요가 없다.

```text
GET https://opendict.korean.go.kr/api/search
    ?key=발급받은키&q=太守&advanced=y&target=2&lang=2
    &method=exact&req_type=json
```

- `advanced=y`: 상세 검색 옵션 활성화.
- `target=2`: 원어 검색, `lang=2`: 한자, `method=exact`: 일치.
- 검색 결과는 표제어·뜻풀이·의미번호·품사·원어·대상 코드 등의 명세를 제공한다.
- 상세는 `/api/view?method=target_code&q=대상코드`이며 키를 포함한다.

[표준국어대사전 명세](https://stdict.korean.go.kr/openapi/openApiInfo.do)의 주소는 `/api/search.do`, `/api/view.do`다. 원어 검색은 `advanced=y&target=2&method=exact`다. 키가 필요하며 **유효한 키로 표본 검색이 성공하는 것까지 검증하지 않았다.** 잘못된 키에 HTTP 200이 나오더라도 정상 사전 응답의 증거가 아니다.

공식 다운로드 경로도 확인했다.

- [표준국어대사전 도움말](https://stdict.korean.go.kr/help/helpList.do): 로그인 → 내 정보 관리 → 사전 내려받기 → 전체 내려받기. 전체 MS Excel 파일을 안내한다.
- [우리말샘 자세히 찾기](https://opendict.korean.go.kr/search/deepSearchResult?fv=true): Excel·HWP·Word·텍스트·XML·JSON 다운로드 선택과 전문가 감수/참여자 제안 정보 구분이 있다. 전체 DB 다운로드를 실행하지는 않았다.

[우리말샘](https://opendict.korean.go.kr/service/copyrightPolicy)과 [표준국어대사전](https://stdict.korean.go.kr/join/copyrightPolicy.do)의 저작권 정책은 사전 정보에 CC BY-SA 2.0 대한민국 조건, 상업적 이용·저작자 표시·변경물의 동일 조건 배포를 안내한다. 출전 있는 용례와 멀티미디어는 별도 권리 조건을 확인해야 한다. 이 조건만으로 앱의 모든 코드를 같은 라이선스로 공개해야 한다고 해석하지 않는다.

**판단:** 한자어 뜻풀이를 합법적으로 API/파일로 확보하는 구체적인 경로. 한자의 모든 고전 자의·허사·통가를 다루는 옥편의 대체물은 아니다. AI 관련 별도 포괄 허용·금지 조항은 확인하지 못했다.

## 8. 다운로드 가능한 무료 자료와 부족한 부분

### 한국어 위키낱말사전 / Kaikki

[한국어판 JSONL 다운로드](https://kaikki.org/kowiktionary/rawdata.html)는 한국어 풀이를 포함한다. 영어판의 Korean 항목과 다른 자료다. 현재 안내는 2026-09-01 덤프에서 2026-09-05 추출한 데이터다. 사전 내용과 추출 코드의 라이선스는 구분하며, Wikimedia 원문 저작자 표시와 내용의 CC BY-SA 조건을 유지해야 한다.

앞선 실제 다운로드 파일에서 이번에 `目·行·謚·諡·皁·太守·提調·太常·皁隷`를 다시 비교했다. 한자·한국어·중국어 항목으로 범위를 제한했을 때:

- 目는 눈 중심의 설명으로 e-hanja의 15개 자의를 대체하지 못했다.
- 謚는 없었고 諡의 시호 관련 항목은 있었다.
- 太守는 있었지만 提調·太常·皁隷는 없었다.

**판단:** 실제 다운로드·가공 가능한 무료 보조 사전. 누락과 자의 깊이를 검수해야 한다. 이 표본만으로 전체 데이터의 품질·커버리지를 일반화하지 않는다.

### libhangul의 hanja.txt

[공식 파일](https://github.com/libhangul/libhangul/blob/main/data/hanja/hanja.txt)은 한글 독음·한자 표기·짧은 훈 형식이다. 파일 자체의 BSD 3-Clause 고지를 확인했다. 라이브러리 코드 전체의 라이선스와 구분한다.

실제 표본에서 目는 짧은 대표 훈, 太守·提調·太常은 독음과 표기는 있지만 설명 칸이 비어 있었다. 謚·諡·皁 등의 독음/짧은 훈은 일부 있지만 전문적인 다의 설명이 아니다. **판단:** 오프라인 기본 훈음·입력 보조용.

### 옥편 원전 PDF와 제외 후보

- [공유마당 (증보)자전석요](https://gongu.copyright.or.kr/gongu/wrt/wrt/view.do?menuNo=200019&wrtSn=9082919): 지석영, 1918년, 국회도서관 출처, 자유이용 만료 표시. 공식 파일의 앞부분에서 PDF 형식과 약 497MB·468쪽 메타데이터를 확인했다. 전체 파일·본문·텍스트 추출성은 검사하지 않았다. 현대 한국어 구조화 DB가 아니라 전산화·교정할 원전 후보다.
- [Nexum 샘플](https://nexum.kr/exam/sample_download.jsp): 실제 XLSX는 헤더 포함 101행, `hangul/hanja` 두 열뿐. 뜻풀이가 없어 상세 옥편 후보에서 제외했다. 홈페이지 99만원 표시는 뜻풀이 DB의 검증된 견적이 아니다.
- [다올소프트](https://www.daolsoft.com/business/content-licensing): 콘텐츠 라이선스 사업은 있으나 특정 한국어 옥편 공급 조건은 미확인.
- [SELVAS DioDict](https://www.selvasai.com/diodict): 사전 앱·오프라인 사용 설명은 있으나 외부 앱용 한국어 옥편 DB 공급 상품은 미확인.
- 옛 한자딕 다운로드 자료는 출처·데이터 라이선스를 확보하지 못했고 한국어 상세 풀이 조건도 부족하여 추천하지 않는다.

관련 기존 조사: [한국어 사전 공급 후보](korean-hanja-dictionary-sources.md), [다국어를 포함한 자료와 파일 검증](hanja-dictionary-sources.md), [사이버서당·앱 적용 초기 조사](hanja-dictionary-research.md).

## 문해에 적용할 판단

| 필요한 기능 | 우선 후보 | 확인 수준 |
|---|---|---|
| 클릭한 한자의 여러 한국어 뜻·독음·이체 관계 | e-hanja 정식 DB 공급 | 콘텐츠·공급 사업 확인, 계약 범위·가격 미확인 |
| 오프라인 기본 훈음 | libhangul | 파일·라이선스 확인 |
| 한자어의 한국어 뜻풀이 | 국립국어원 API/다운로드 | 공식 명세·다운로드 경로 확인, 발급 키 호출 미검증 |
| 한국 고문헌 관직·제도·출전 | 단국대, KOSTMA | 실제 본문 확인. KOSTMA 외부 위젯 안내 있음 |
| 다른 사전과 대조 열람 | 네이버·Daum·존한자 링크 | 웹 조회 확인, 내용 재배포 권한 미확인 |

제품 설계상 낱자·어휘를 분리하고 정확한 표제어·출처·자의 번호·원문 자형을 보존하는 것이 필요하다. 예를 들어 `議謚`에서는 謚/諡와 독음별 뜻을 비교해야 하고, `提調`에서는 두 낱자의 대표 훈보다 관직의 출전과 시대가 유효한 근거다. AI에는 번역가가 선택한 자의와 출처를 연결하는 방식이 적합하다. 계약 후보에는 화면 표시뿐 아니라 프로젝트 저장·오프라인 배포·외부 AI 문맥 입력의 실제 사용 범위를 함께 확인해야 한다.

이 문서는 조사 결과이며 앱 통합·가입·계약·구매를 완료했다는 뜻은 아니다.
