begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception 'Assertion failed: %', message; end if; end $$;

select pg_temp.assert_true(not has_table_privilege('anon', 'public.plugin_catalog', 'select'), 'anon cannot read');
select pg_temp.assert_true(has_table_privilege('authenticated', 'public.plugin_catalog', 'select'), 'signed-in apps can read');
select pg_temp.assert_true(not has_table_privilege('authenticated', 'public.plugin_catalog', 'insert'), 'client cannot insert');
select pg_temp.assert_true(not has_table_privilege('authenticated', 'public.plugin_catalog', 'update'), 'client cannot update');
select pg_temp.assert_true(not has_table_privilege('authenticated', 'public.plugin_catalog', 'delete'), 'client cannot delete');
select pg_temp.assert_true((select relrowsecurity from pg_class where oid = 'public.plugin_catalog'::regclass), 'RLS enabled');

set local role service_role;
insert into public.plugin_catalog (name, content, sort_order, published) values
  ('sillok-style', E'---\nname: sillok-style\ndescription: 실록 문체\n---\n본문\n', 1, true),
  ('draft-guide', E'---\nname: draft-guide\ndescription: 검토 중\n---\n본문\n', 2, false);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.assert_true((select array_agg(name order by sort_order) = array['sillok-style'] from public.plugin_catalog), 'only published rows are visible');
reset role;

do $$ begin
  insert into public.plugin_catalog (name, content) values ('translate-document', 'x');
  raise exception 'reserved name accepted';
exception when check_violation then null; end $$;
do $$ begin
  insert into public.plugin_catalog (name, content) values ('Bad Name', 'x');
  raise exception 'invalid name accepted';
exception when check_violation then null; end $$;
rollback;
