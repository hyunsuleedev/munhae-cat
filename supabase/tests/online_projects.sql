-- Run only through scripts/test-online-projects.mjs, which creates an isolated
-- local PostgreSQL cluster. No Supabase credentials or existing user data are used.
begin;

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.online_projects'::regclass) then
    raise exception 'RLS must be enabled';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.create_online_project(text,text,uuid)'::regprocedure) then
    raise exception 'RPC must preserve the caller RLS boundary';
  end if;
  if has_function_privilege('anon', 'public.create_online_project(text,text,uuid)', 'EXECUTE')
    or has_table_privilege('anon', 'public.online_projects', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'Anonymous access must be revoked';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
do $$
declare
  first_project public.online_projects;
  repeated_project public.online_projects;
begin
  select * into first_project from public.create_online_project(
    '  관서악부서  ', '  온라인 프로젝트 설명  ', '00000000-0000-4000-8000-000000000010');
  select * into repeated_project from public.create_online_project(
    '관서악부서', '온라인 프로젝트 설명', '00000000-0000-4000-8000-000000000010');
  if first_project.id <> repeated_project.id or first_project.owner_id <> auth.uid()
    or first_project.title <> '관서악부서' or first_project.description <> '온라인 프로젝트 설명'
    or first_project.created_at <> repeated_project.created_at
    or first_project.updated_at <> repeated_project.updated_at then
    raise exception 'Idempotency, normalization, ownership, or immutable timestamps failed';
  end if;
  if (select count(*) from public.online_projects) <> 1 then
    raise exception 'Repeated request created duplicate projects';
  end if;
  begin
    perform public.create_online_project('다른 이름', '온라인 프로젝트 설명', '00000000-0000-4000-8000-000000000010');
    raise exception 'Changed retry payload must fail';
  exception when unique_violation then
    if sqlerrm <> 'ONLINE_PROJECT_REQUEST_CONFLICT' then raise; end if;
  end;
  begin
    perform public.create_online_project(' ', '', gen_random_uuid());
    raise exception 'Blank title must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_online_project(E'\t\n', '', gen_random_uuid());
    raise exception 'Whitespace-only title must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_online_project(U&'\00A0\3000', '', gen_random_uuid());
    raise exception 'Unicode whitespace-only title must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    insert into public.online_projects (title, request_id) values (E'\t\n', gen_random_uuid());
    raise exception 'Direct table writes must enforce title constraints';
  exception when check_violation then null;
  end;
  begin
    perform public.create_online_project(E'첫째\n둘째', '', gen_random_uuid());
    raise exception 'RPC must reject multiline titles';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_online_project(E'첫째\r둘째', '', gen_random_uuid());
    raise exception 'RPC must reject carriage returns in titles';
  exception when invalid_parameter_value then null;
  end;
  begin
    insert into public.online_projects (title, request_id) values (E'첫째\r\n둘째', gen_random_uuid());
    raise exception 'Direct table writes must reject multiline titles';
  exception when check_violation then null;
  end;
  begin
    perform public.create_online_project(repeat('가', 161), '', gen_random_uuid());
    raise exception 'Long title must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_online_project('제목', repeat('가', 4001), gen_random_uuid());
    raise exception 'Long description must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.create_online_project('제목', '', null);
    raise exception 'Missing idempotency key must fail';
  exception when invalid_parameter_value then null;
  end;
  begin
    insert into public.online_projects (owner_id, title, request_id)
    values ('00000000-0000-4000-8000-000000000002', '소유자 위조', gen_random_uuid());
    raise exception 'Clients must not assign owners';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.online_projects (title, request_id, created_at)
    values ('시각 위조', gen_random_uuid(), '2000-01-01');
    raise exception 'Clients must not assign server timestamps';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.online_projects set title = '수정';
    raise exception 'UPDATE must not be granted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.online_projects;
    raise exception 'DELETE must not be granted';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
do $$
begin
  if exists (select 1 from public.online_projects) then
    raise exception 'Account B must not read account A projects';
  end if;
  perform public.create_online_project('별도 계정', '', '00000000-0000-4000-8000-000000000010');
  if (select count(*) from public.online_projects) <> 1 then
    raise exception 'Request keys must be scoped to the account';
  end if;
end;
$$;

select set_config('request.jwt.claims', '{}', true);
do $$
begin
  if exists (select 1 from public.online_projects) then
    raise exception 'Missing user must see no projects';
  end if;
  begin
    perform public.create_online_project('로그인 필요', '', gen_random_uuid());
    raise exception 'Missing user must not create a project';
  exception when insufficient_privilege then null;
  end;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform * from public.online_projects;
    raise exception 'Anonymous select must fail';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_online_project('익명', '', gen_random_uuid());
    raise exception 'Anonymous RPC must fail';
  exception when insufficient_privilege then null;
  end;
end;
$$;

rollback;
