# 문해 Premium 결제

## 상품과 구현 방향

- Premium: 사용자 계정당 **월 19,000원(KRW)**, 수량 1. 연간 요금제와 무료 체험은 추가하지 않는다.
- 결제: Stripe-hosted Checkout의 subscription 모드. 카드 정보는 문해가 수집하지 않는다.
- 관리: 문해 전용 Customer Portal 설정으로 결제 수단, 청구서 내역, 구독 해지 제공. 해지는 결제 기간 말에 적용한다.
- 청구서: Stripe Billing이 정기 결제마다 생성한다. 별도의 수동 청구서 발송 기능은 포함하지 않는다.
- 계정: Supabase Auth 사용자 ID와 Stripe Customer를 서버에서 연결한다. Stripe 계정·test/live 환경도 함께 구분한다.
- 협업 정원: Premium 온라인 프로젝트별 **소유자 포함 총 5명**으로 결정했다. 편집자·열람자와 유효한 수락 대기 초대를 합산하며, 상세 기준은 `docs/online-projects.md`를 따른다. 정책만 확정했으며 초대 기능과 서버 정원 제한은 아직 구현하지 않았다.
- 로컬 문서 사용과 온라인 프로젝트 접근 제한 정책은 이번 결제 연결과 별도로 확정한다. 현재 구현만으로 기존 문서를 차단하지 않는다.

2026-09-22에 공식 Stripe 플러그인 `stripe@openai-curated`를 설치했다. `https://mcp.stripe.com`에 기존 Stripe CLI의 테스트 인증으로 연결하고 실제 `stripe_implementation_planner`를 호출했다. 가이드 `iguide_61VRzty8jP78j41PS41CWO4YNaahk`에서 hosted Checkout, 월 정액, 선결제, Customer Portal을 선택해 accepted 응답을 받았다. 플러그인/MCP를 사용했으므로 수동 skills 설치 대안은 사용하지 않았다. Codex용 지속 OAuth 인증은 별도 연결 절차다.

참고: [구독 Checkout](https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=checkout&ui=stripe-hosted), [Customer Portal](https://docs.stripe.com/customer-management/integrate-customer-portal), [구독 웹훅](https://docs.stripe.com/billing/subscriptions/webhooks), [Stripe MCP](https://docs.stripe.com/mcp).

## 데이터 흐름

1. 데스크톱 main 프로세스 또는 로그인된 웹의 `/billing/`에서 Supabase `billing` Edge Function을 호출한다.
2. 서버는 Bearer token을 `auth.getUser`로 검증하고 자신의 고객 매핑만 사용한다. 클라이언트가 가격·사용자·Customer·이동 URL을 지정할 수 없다.
3. 서버가 지정된 계정, test/live 모드, 월 19,000원 Price를 확인한 뒤 Checkout 세션을 생성한다.
4. 결제가 끝나면 `/billing/?checkout=success`로 돌아온다. 이 URL은 권한 부여 근거가 아니다. 화면은 서버의 구독 상태를 다시 읽는다.
5. `stripe-webhook`이 원문 요청 본문과 Stripe 서명을 검증한다. Stripe의 최신 구독 상태를 읽어 PostgreSQL에 반영한다. 중복 수신과 동시 처리는 서버에서 통제한다.
6. 앱은 저장된 구독 상태를 조회한다. 계정 전환 뒤 도착한 이전 요청의 결과는 적용하지 않는다.

함수 요청은 POST JSON `{ "action": "status" | "checkout" | "portal" }`이다.

```ts
type BillingStatus = {
  plan: 'free' | 'premium';
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  configured: boolean;
};
// checkout, portal: { url: string }
// 오류: { error: string, message?: string }
```

비밀 키는 Supabase 서버에만 둔다. Electron, preload, 웹 번들에는 Stripe secret key나 Supabase service-role key를 넣지 않는다. 데스크톱은 main 프로세스에서 반환 URL을 검증해 외부 브라우저로 열며, renderer에 로그인 토큰을 전달하지 않는다.

## 서버 설정

Supabase의 기본 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` 외에 다음 서버 환경변수를 사용한다.

| 환경변수 | 내용 |
| --- | --- |
| `STRIPE_SECRET_KEY` | 선택한 Stripe 계정의 서버용 키 |
| `STRIPE_WEBHOOK_SECRET` | 배포한 webhook endpoint의 서명 비밀 값 |
| `STRIPE_ACCOUNT_ID` | 허용하는 Stripe 계정 ID |
| `STRIPE_MODE` | `test` 또는 `live` |
| `STRIPE_PREMIUM_PRICE_ID` | 문해 월 19,000원 Price ID |
| `STRIPE_PORTAL_CONFIGURATION_ID` | 문해 전용 Portal 설정 ID |
| `BILLING_SITE_URL` | `https://munhaestudio.com` |
| `BILLING_ALLOWED_ORIGINS` | 선택 사항. 개발용 웹 origin을 쉼표로 구분. localhost HTTP는 test 모드에서만 허용 |

상품과 Price, Portal에는 `metadata.application=munhae`를 붙인다. Price는 `krw`, `unit_amount=19000`, 월 간격 1, 세금 포함 가격(`tax_behavior=inclusive`)으로 생성한다. Stripe Tax 등록·징수 설정은 사업자 확인 후 별도로 구성한다. 구현 자체가 세금 의무를 판단하거나 등록을 대신하지 않는다.

CLI 로그인 키는 개발 도구 인증이다. 만료될 수 있는 CLI 키를 운영 서버의 영구 자격 증명으로 사용하지 않는다.

## 상품 준비

현재 CLI 기본 프로필이 문해 전용 계정이라는 보장은 없다. 계정 선택을 먼저 확인한다. 아래 명령은 읽기만 수행하며, 계정 ID 및 테스트 모드를 검증한다.

```sh
node scripts/setup-stripe-billing.mjs --account acct_선택한계정
```

`--apply`를 명시하면 선택한 모드에 문해 상품·월 Price·전용 Portal 설정을 만든다. 기본은 테스트 모드이며, 운영 모드는 `--live`를 명시해야 한다. 계정 ID와 모드를 확인하며, 운영 계정의 결제가 비활성화돼 있으면 중단한다. 기존 문해 설정이 있으면 재사용한다. 고객·구독·결제를 생성하지 않는다.

```sh
node scripts/setup-stripe-billing.mjs --account acct_선택한계정 --apply
# 명시적으로 승인된 문해 운영 전환
node scripts/setup-stripe-billing.mjs --profile munhae --account acct_1UEFAWA3GOt8qQ7V --live --apply
```

웹훅 주소는 `https://xanucaevzpwwabnmpamm.supabase.co/functions/v1/stripe-webhook`이다. 함수 배포와 비밀 값 설정을 완료한 뒤 동일한 Stripe 모드의 endpoint를 연결한다. 기존 다른 사업의 endpoint나 기본 Portal 설정을 변경하지 않는다.

웹훅에는 다음 이벤트를 등록한다: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.marked_uncollectible`, `invoice.voided`, `invoice.finalized`. Endpoint API 버전은 함수의 `STRIPE_API_VERSION`과 맞춘다.

서버 배포 명령(스키마를 먼저 적용):

```sh
supabase functions deploy billing stripe-webhook \
  --project-ref xanucaevzpwwabnmpamm --use-api \
  --import-map supabase/functions/deno.json
```

두 함수의 플랫폼 `verify_jwt`는 꺼져 있다. `billing`은 함수 안에서 Supabase Auth로 실제 사용자를 검증하고, `stripe-webhook`은 Stripe 서명으로 요청을 검증한다. 비밀 값을 넣기 전에는 로그인한 사용자의 상태 조회만 `configured:false`로 응답하고 결제 세션을 만들지 않는다.

## 공개 전 확인

- 선택한 Stripe 사업자 계정과 운영용 키·Price·Portal·웹훅의 모드가 일치해야 한다.
- 익명/다른 사용자가 구독 정보를 읽거나 변경할 수 없는지 확인한다.
- 테스트 Checkout 결제 → 웹훅 → Premium 표시를 실제 경로로 확인한다.
- 중복 Checkout 요청, 서명 위조, 재전송·역순 웹훅, 결제 실패, 기간 말 해지를 확인한다.
- 웹 성공 URL만으로 Premium이 부여되지 않아야 한다.
- 운영 배포와 테스트 통과, 실제 고객 결제 완료는 각각 별도 상태로 기록한다.

## 현재 확인된 상태 (2026-09-23)

- 문해 Supabase에 `20260922222326_stripe_billing`과 `20260922222459_stripe_billing_subscription_index` 적용, `billing`과 `stripe-webhook` 함수 배포 완료.
- 문해 전용 CLI 프로필 `munhae`, 계정 `acct_1UEFAWA3GOt8qQ7V`를 확인했다. 기존 기본 CouKey 프로필은 변경하지 않았다. 실제 앱 인증 경로에서 `configured:true`, Checkout·Portal 열기를 확인했다.
- 원격 서버에서 무인증 요청 401, 허용되지 않은 origin 403, 공식 사이트 preflight 204를 확인했다.
- 결제 테이블 3개 모두 RLS 활성화. 익명 읽기, 일반 사용자의 직접 변경 및 내부 RPC 실행은 허용하지 않는다.
- 데스크톱 52개, 웹 billing 9개·auth 18개, 서버 15개 동작 테스트 통과. 별도 PostgreSQL에서 권한·계정/모드 분리·동시 요청·트랜잭션 롤백을 검증했다. 테스트 상품 준비 스크립트의 6개 검증도 통과했다.
- 웹 `/billing/`은 로컬 구현·빌드·모바일 화면 검증까지 완료했으며 공식 사이트에는 아직 배포하지 않았다.
- 테스트 상품 `munhae_premium`, Price `price_1UIncEA3GOt8qQ7VBthc3nEH`(KRW 19,000/월), Portal `bpc_1UIncFA3GOt8qQ7VqtIz7JAG`, webhook `we_1UInckA3GOt8qQ7VoU2jrwKZ`를 생성하고 Supabase에 연결했다.
- 서버는 현재 **test 모드**이며 개발용 CLI 테스트 키를 사용한다. 키 만료일은 2026-12-22이므로 실서비스 전에 영구 서버용 운영 키와 live 리소스로 교체해야 한다. 비밀 값은 문서·클라이언트에 저장하지 않았다.
- 실제 Stripe hosted Checkout에서 테스트 카드 결제 완료, 19,000원 결제 청구서 생성, 서명된 웹훅의 DB 반영, 앱의 `premium / active` 응답을 확인했다. Portal에서 청구서·결제 수단·기간 말 구독 해지도 확인했다. 실제 금전 청구는 없었다.
- 계정의 기본 Managed Payments 설정이 고정 KRW 설정과 충돌하여 Checkout에 `managed_payments.enabled=false`를 명시했다. [Stripe 문서](https://docs.stripe.com/payments/managed-payments/update-checkout)를 근거로 직접 Billing 경로를 유지한다. 계정 전체 설정은 변경하지 않았다.
- Flexible Billing Portal은 해지 예약을 `cancel_at`으로 보내므로 기간 말 boolean과 함께 정규화한다. 유효 이용기간은 결제 기간 끝과 해지일 중 빠른 날짜로 제한하며 관련 회귀 테스트를 추가했다.
- 공식 `/billing/` 복귀 주소는 아직 404다. 웹 배포와 운영 키 전환까지 끝나기 전에는 실서비스 결제 완료로 보지 않는다.
- Premium 적용 기능 범위는 미확정이다. 온라인 프로젝트에 새로운 구독 제한을 적용하지 않았다.

검증에 사용한 테스트 구독 `sub_1UInhpA3GOt8qQ7VYk7pnI0W`은 기간 말 해지 표시를 확인한 뒤 즉시 종료하여 정리했다. 테스트 청구서는 감사 기록으로 남긴다.

## 운영 전환 완료 (2026-09-23)

- 사용자 요청에 따라 문해 계정 `acct_1UEFAWA3GOt8qQ7V`를 live 모드로 연결했다. 기존 CouKey 프로필은 변경하지 않았다.
- 운영 `charges_enabled`, `payouts_enabled`, `details_submitted` 모두 true, 현재 필수 제출 항목 없음 확인.
- 승인된 Products, Prices, Customer Portal, Webhook Endpoints 쓰기 권한을 문해 전용 CLI 키에 적용하고 API로 확인했다.
- 운영 상품 `munhae_premium`, Price `price_1UIo0vA3GOt8qQ7V5uVosHAW`(KRW 19,000/월), Portal `bpc_1UIo0wA3GOt8qQ7V6pzzmmGK` 생성 완료.
- 운영 웹훅 `we_1UIo1OA3GOt8qQ7VV1Tl2AO3`: API 버전 `2026-08-26.dahlia`, 구독·Checkout·청구서 관련 14개 이벤트.
- 사용자가 Stripe 패스키 재인증을 완료한 후 기존 표준 운영 키를 Supabase CLI로 저장했다. 만료되는 CLI 키를 운영 서버에 사용하지 않는다. 운영 환경값 8개를 저장하고 Supabase 비밀 값 digest와 일치함을 검증했다. 개발용 origin은 제거했다.
- 키는 채팅·로그·저장소에 출력하지 않았으며 비밀 값 임시 파일은 삭제했다. 서버 키와 웹훅 서명 키는 Supabase Edge Function secrets에만 저장했다.
- 웹 billing 9개·auth 18개 및 production build 통과 후 준비된 배포본 `dpl_6V3eo5vGZq73rUvYKQswVM7vHfAZ`를 공식 도메인으로 승격했다. `vercel promote`는 URL과 `--scope hyunsulocks-projects`를 명시해 완료했다.
- https://munhaestudio.com/billing/ HTTP 200 및 실제 Chrome 구독 페이지 표시 확인. 운영 Checkout에서 문해 Premium, 매월 19,000원과 결제 수단 표시를 확인했고 결제하지 않고 공식 페이지로 돌아왔다.
- 로그인된 데스크톱 계정의 서버 조회는 `configured:true`, `plan:free`, `status:null`. 테스트 구독이 운영 권한으로 넘어오지 않음을 확인했다.
- 운영 서버에서 무인증 요청 401, 개발용 localhost origin 요청 403 확인.
- 실제 운영 청구는 실행하지 않았다. 운영 결제 후 서명 웹훅의 구독 반영은 첫 실결제 전까지 미검증이다. 테스트 모드에서는 결제·웹훅·해지 예약까지 검증했다.
- Premium 기능별 제한, 팀 구독과 좌석 과금은 아직 구현하지 않았다. 현재 구독은 개인 계정 단위다.
