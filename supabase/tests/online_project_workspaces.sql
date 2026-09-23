-- Only run in the disposable PostgreSQL cluster created by the local test script.
begin;
insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
insert into public.online_projects (id, owner_id, title, request_id) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', '원문 연구', gen_random_uuid()),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', '별도 계정', gen_random_uuid());

create function pg_temp.expect_error(statement text, expected_message text)
returns void language plpgsql security invoker as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlerrm not like '%' || expected_message || '%' then
      raise exception 'Unexpected error: % (wanted %)', sqlerrm, expected_message;
    end if;
    return;
  end;
  raise exception 'Expected failure: %', expected_message;
end;
$$;

do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like '%online_workspace%' and p.prosecdef) then
    raise exception 'No public SECURITY DEFINER endpoints';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.proname like '%online_workspace%'
      and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'No anonymous workspace functions';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.online_project_workspaces'::regclass) then
    raise exception 'Workspace RLS required';
  end if;
end;
$$;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';
do $$
declare
  first_head public.online_project_workspaces;
  second_head public.online_project_workspaces;
begin
  select * into first_head from public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201');
  select * into second_head from public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201');
  if first_head.fence <> 1 or second_head.fence <> 1 or first_head.revision <> 0
    or first_head.object_path is not null or first_head.owner_id <> auth.uid()
    or extract(epoch from (first_head.lease_expires_at - clock_timestamp())) not between 118 and 120 then
    raise exception 'Initial acquisition, lease TTL, or retry idempotency failed';
  end if;
  select * into second_head from public.renew_online_workspace(first_head.project_id, first_head.lease_id, first_head.fence);
  if second_head.fence <> first_head.fence then raise exception 'Renew must not replace the fence'; end if;
end;
$$;
select pg_temp.expect_error($q$select public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000202')$q$, 'ONLINE_WORKSPACE_LOCKED');
select pg_temp.expect_error($q$select public.renew_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000202',1)$q$, 'ONLINE_WORKSPACE_LEASE_LOST');
select pg_temp.expect_error($q$update public.online_project_workspaces set revision=99$q$, 'permission denied');

insert into storage.objects (bucket_id,name,metadata,user_metadata) values (
  'online-project-workspaces',
  '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000301.munhaepkg',
  '{"size":32,"mimetype":"application/zip"}', '{"lease_id":"00000000-0000-4000-8000-000000000201"}'
);
select pg_temp.expect_error($q$insert into storage.objects (bucket_id,name,metadata,user_metadata) values ('online-project-workspaces','00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000302.munhaepkg','{}','{"lease_id":"00000000-0000-4000-8000-000000000202"}')$q$, 'row-level security');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id,name,metadata,user_metadata) values ('online-project-workspaces','00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000102/1/00000000-0000-4000-8000-000000000302.munhaepkg','{}','{"lease_id":"00000000-0000-4000-8000-000000000201"}')$q$, 'row-level security');
do $$
begin
  update storage.objects set metadata = '{}' where bucket_id = 'online-project-workspaces';
  if found then raise exception 'Objects must not be overwritten'; end if;
  delete from storage.objects where bucket_id = 'online-project-workspaces';
  if found then raise exception 'Objects must not be deleted'; end if;
end;
$$;

select pg_temp.expect_error($q$select public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,0,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000399.munhaepkg',repeat('a',64),32)$q$, 'ONLINE_WORKSPACE_CHECKPOINT_MISSING');
select pg_temp.expect_error($q$select public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,0,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000301.munhaepkg',repeat('a',64),31)$q$, 'ONLINE_WORKSPACE_CHECKPOINT_INVALID');
do $$
declare
  first_head public.online_project_workspaces;
  second_head public.online_project_workspaces;
begin
  select * into first_head from public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,0,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000301.munhaepkg',repeat('a',64),32);
  select * into second_head from public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,0,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000301.munhaepkg',repeat('a',64),32);
  if first_head.revision <> 1 or second_head.revision <> 1 or first_head.updated_at <> second_head.updated_at then
    raise exception 'Commit/retry must advance revision exactly once';
  end if;
  if (select updated_at from public.online_projects where id = first_head.project_id) <> first_head.updated_at then
    raise exception 'Parent project modification time must follow the committed checkpoint';
  end if;
end;
$$;
select pg_temp.expect_error($q$select public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,0,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000301.munhaepkg',repeat('b',64),32)$q$, 'ONLINE_WORKSPACE_CONFLICT');

set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000002"}';
do $$
begin
  if exists (select 1 from public.online_project_workspaces) or exists (select 1 from storage.objects) then
    raise exception 'Account B must not read account A data';
  end if;
end;
$$;
select pg_temp.expect_error($q$select public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000202')$q$, 'ONLINE_WORKSPACE_FORBIDDEN');
select pg_temp.expect_error($q$select private.release_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1)$q$, 'ONLINE_WORKSPACE_FORBIDDEN');

reset role;
update public.online_project_workspaces set lease_expires_at = clock_timestamp() - interval '1 second';
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_error($q$select public.renew_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1)$q$, 'ONLINE_WORKSPACE_LEASE_LOST');
select pg_temp.expect_error($q$select public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,1,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000302.munhaepkg',repeat('a',64),32)$q$, 'ONLINE_WORKSPACE_LEASE_LOST');
do $$
declare
  head public.online_project_workspaces;
begin
  select * into head from public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000202');
  if head.fence <> 2 or head.revision <> 1 then raise exception 'Expired takeover must increment fence and retain content'; end if;
  if public.release_online_workspace(head.project_id,'00000000-0000-4000-8000-000000000201',1) then
    raise exception 'Stale release must not release the newer writer';
  end if;
  select * into head from public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,0,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000301.munhaepkg',repeat('a',64),32);
  if head.fence <> 2 or head.revision <> 1 or head.lease_id <> '00000000-0000-4000-8000-000000000202' then
    raise exception 'Acknowledging an old successful commit must preserve the new lease';
  end if;
end;
$$;
select pg_temp.expect_error($q$insert into storage.objects (bucket_id,name,metadata,user_metadata) values ('online-project-workspaces','00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000302.munhaepkg','{}','{"lease_id":"00000000-0000-4000-8000-000000000201"}')$q$, 'row-level security');
select pg_temp.expect_error($q$select public.commit_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000201',1,1,'00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/1/00000000-0000-4000-8000-000000000302.munhaepkg',repeat('a',64),32)$q$, 'ONLINE_WORKSPACE_LEASE_LOST');
set local request.jwt.claims = '{}';
select pg_temp.expect_error($q$select public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000202')$q$, 'ONLINE_WORKSPACE_FORBIDDEN');
set local role anon;
select pg_temp.expect_error($q$select public.acquire_online_workspace('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000202')$q$, 'permission denied');
select pg_temp.expect_error($q$select * from public.online_project_workspaces$q$, 'permission denied');
rollback;
