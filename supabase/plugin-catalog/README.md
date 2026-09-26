# 추천 플러그인 카탈로그

앱의 설정 → 플러그인 → 추천 플러그인에 보이는 목록의 원본이다. 각 폴더의 `SKILL.md`가 Supabase `plugin_catalog` 한 행이 된다.

- 플러그인은 기본 번역 스킬(`translate-document`)을 통째로 대체한다. 원문 전체 번역, 누락 금지, 불확실성 표시 같은 기본 원칙을 각 `SKILL.md`에 함께 적는다.
- `catalog.json`의 순서가 앱의 표시 순서이고, `published: true`인 항목만 앱에 보인다.
- 내용을 고치면 frontmatter의 `version`을 올린다. 설치한 사용자에게 "업데이트"가 표시된다.

반영: `node scripts/sync-plugin-catalog.mjs --dry-run`으로 확인한 뒤 `node scripts/sync-plugin-catalog.mjs`를 실행한다. 연결된 Supabase 프로젝트(`supabase/.temp/project-ref`)에 upsert하며, service key는 Supabase CLI에서 실행할 때만 가져오고 저장하지 않는다.
