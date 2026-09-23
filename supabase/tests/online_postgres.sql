-- Run only through the disposable local cluster harness.
begin;
insert into auth.users values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002');
insert into public.online_projects(id,owner_id,title,request_id) values
 ('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001','A',gen_random_uuid()),
 ('00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000002','B',gen_random_uuid());
insert into public.online_project_data(project_id) values('00000000-0000-4000-8000-000000000102');
insert into public.online_data_core_actors(online_project_id,id,actor_kind,display_name,created_at)
 values('00000000-0000-4000-8000-000000000102','foreign-actor','human','Another owner','2026-09-22');
create function pg_temp.expect_error(statement text,expected text) returns void language plpgsql as $$begin
 begin execute statement;exception when others then if position(expected in sqlerrm)=0 then raise exception 'Unexpected: %; expected: %',sqlerrm,expected;end if;return;end;
 raise exception 'Expected error: %',expected;end$$;
create function pg_temp.full_row(table_name text,values_json jsonb) returns jsonb language plpgsql as $$declare row_json jsonb;begin
 execute format('select to_jsonb(jsonb_populate_record(null::public.%I,$1))-''online_project_id''','online_data_'||table_name) into row_json using values_json;return row_json;end$$;
do $$begin
 if (select count(*) from pg_tables where schemaname='public' and tablename like 'online_data_%')<>48 then raise exception '48 normalized tables required';end if;
 if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'online_data_%' and c.relkind='r' and not c.relrowsecurity) then raise exception 'RLS missing';end if;
 if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('get_online_project_data','commit_online_project_data','get_online_project_changes') and (p.prosecdef or has_function_privilege('anon',p.oid,'EXECUTE'))) then raise exception 'Public API permissions invalid';end if;
 if (select count(*) from pg_publication_tables where pubname='supabase_realtime')<>1 or not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='online_project_data') then raise exception 'Only metadata may be published';end if;
end$$;
set local role authenticated;
set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000001"}';
do $$declare
 p uuid:='00000000-0000-4000-8000-000000000101'; actor jsonb; project jsonb; master jsonb; changes jsonb; result jsonb; response jsonb; bad jsonb; altered jsonb; asset jsonb; location jsonb;
begin
 response:=public.get_online_project_data(p);
 if response->>'revision'<>'0' or response->>'updated_at' is null or (select count(*) from jsonb_object_keys(response->'tables'))<>48 then raise exception 'Empty project snapshot invalid';end if;
 actor:=pg_temp.full_row('core_actors','{"id":"actor","actor_kind":"human","display_name":"연구자","created_at":"2026-09-22T00:00:00.000Z"}');
 project:=pg_temp.full_row('core_projects','{"id":"local-project","title":"문해","default_target_locale":"ko","status":"active","created_by_actor_id":"actor","created_at":"2026-09-22T00:00:00.000Z","updated_at":"2026-09-22T00:00:00.000Z"}');
 master:=pg_temp.full_row('document_nodes','{"id":"master","project_id":"local-project","parent_node_id":null,"node_role":"container","is_master":1,"title":"문해","ordinal":0,"lock_version":1,"created_at":"2026-09-22T00:00:00.000Z","updated_at":"2026-09-22T00:00:00.000Z"}');
 -- Deliberately child-first: all FKs and source checks must validate at transaction end.
 changes:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',null,'after',master),jsonb_build_object('table','core_projects','key',jsonb_build_object('id','local-project'),'before',null,'after',project),jsonb_build_object('table','core_actors','key',jsonb_build_object('id','actor'),'before',null,'after',actor));
 result:=public.commit_online_project_data(p,0,'00000000-0000-4000-8000-000000000201',10,changes);
 if result->>'revision'<>'1' then raise exception 'Initial commit failed';end if;
 if public.commit_online_project_data(p,0,'00000000-0000-4000-8000-000000000201',10,changes)<>result then raise exception 'Idempotence failed';end if;
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,1,%L,10,%L)',p,'00000000-0000-4000-8000-000000000201',changes),'ONLINE_DATA_MUTATION_CONFLICT');
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,0,%L,10,%L)',p,gen_random_uuid(),'[]'),'ONLINE_DATA_REVISION_CONFLICT');
 altered:=master||'{"title":"수정"}';changes:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',master,'after',altered));
 result:=public.commit_online_project_data(p,1,gen_random_uuid(),10,changes);
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),changes),'ONLINE_DATA_ROW_CONFLICT');
 bad:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',altered,'after',altered||'{"parent_node_id":"master"}'));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),bad),'project master cannot');
 bad:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',altered,'after',null));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),bad),'ONLINE_DATA_MASTER_REQUIRED');
 bad:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',altered,'after',altered||'{"project_id":"other-project"}'));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),bad),'ONLINE_DATA_PROJECT_MISMATCH');
 bad:=jsonb_build_array(jsonb_build_object('table','core_projects','key',jsonb_build_object('id','local-project'),'before',project,'after',project||'{"created_by_actor_id":"foreign-actor"}'));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),bad),'foreign key constraint');
 bad:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',altered,'after',altered||'{"extra":"bad"}'));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),bad),'ONLINE_DATA_INVALID_COLUMNS');
 -- A valid first update must roll back with an invalid second change.
 bad:=jsonb_build_array(jsonb_build_object('table','document_nodes','key',jsonb_build_object('id','master'),'before',altered,'after',altered||'{"title":"must rollback"}'),jsonb_build_object('table','core_projects','key',jsonb_build_object('id','local-project'),'before',project,'after',project||'{"created_by_actor_id":"foreign-actor"}'));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),bad),'foreign key constraint');
 response:=public.get_online_project_data(p);
 if response->>'revision'<>'2' or response->'tables'->'document_nodes'->0->>'title'<>'수정' then raise exception 'Atomic rollback failed';end if;
 response:=public.get_online_project_changes(p,0);
 if jsonb_array_length(response->'commits')<>2 or response->'commits'->1->'changes'->0 ? 'before' then raise exception 'Journal invalid';end if;
 asset:=pg_temp.full_row('src_assets',jsonb_build_object('id','asset','project_id','local-project','asset_kind','image','created_by_actor_id','actor','sha256',repeat('b',64),'byte_size',31));
 location:=pg_temp.full_row('src_asset_locations','{"id":"location","project_id":"local-project","asset_id":"asset","relative_path":"assets/image.png","state":"present"}');
 changes:=jsonb_build_array(jsonb_build_object('table','src_asset_locations','key',jsonb_build_object('id','location'),'before',null,'after',location),jsonb_build_object('table','src_assets','key',jsonb_build_object('id','asset'),'before',null,'after',asset));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),changes),'ONLINE_DATA_ASSET_MISSING');
 insert into storage.objects(bucket_id,name,metadata) values('online-project-assets',auth.uid()::text||'/'||p::text||'/'||repeat('b',64),'{"size":32}');
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,2,%L,10,%L)',p,gen_random_uuid(),changes),'ONLINE_DATA_ASSET_INVALID');
 asset:=asset||'{"byte_size":32}';changes:=jsonb_set(changes,'{1,after}',asset);
 result:=public.commit_online_project_data(p,2,gen_random_uuid(),10,changes);
 if result->>'revision'<>'3' then raise exception 'Uploaded asset commit failed';end if;
 bad:=jsonb_build_array(jsonb_build_object('table','src_assets','key',jsonb_build_object('id','asset'),'before',asset,'after',asset||jsonb_build_object('sha256',repeat('c',64))));
 perform pg_temp.expect_error(format('select public.commit_online_project_data(%L,3,%L,10,%L)',p,gen_random_uuid(),bad),'ONLINE_DATA_ASSET_MISSING');
end$$;
select pg_temp.expect_error($q$select public.get_online_project_data('00000000-0000-4000-8000-000000000102')$q$,'ONLINE_DATA_NOT_FOUND');
select pg_temp.expect_error($q$select public.get_online_project_changes('00000000-0000-4000-8000-000000000102',0)$q$,'ONLINE_DATA_NOT_FOUND');
select pg_temp.expect_error($q$update public.online_data_core_projects set title='bad'$q$,'permission denied');
select pg_temp.expect_error($q$delete from public.online_project_data$q$,'permission denied');
insert into storage.objects(bucket_id,name) values('online-project-assets','00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000101/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
select pg_temp.expect_error($q$insert into storage.objects(bucket_id,name) values('online-project-assets','00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000102/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')$q$,'row-level security');
do $$begin update storage.objects set metadata='{"size":3}' where bucket_id='online-project-assets';if found then raise exception 'Asset overwrite permitted';end if;delete from storage.objects where bucket_id='online-project-assets';if found then raise exception 'Asset delete permitted';end if;end$$;
set local request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000002"}';
do $$begin if exists(select 1 from public.online_data_core_projects) or exists(select 1 from public.online_project_data where project_id='00000000-0000-4000-8000-000000000101') or exists(select 1 from storage.objects) then raise exception 'Cross-account rows leaked';end if;end$$;
select pg_temp.expect_error($q$select public.commit_online_project_data('00000000-0000-4000-8000-000000000101',2,gen_random_uuid(),10,'[]')$q$,'ONLINE_DATA_NOT_FOUND');
set local request.jwt.claims='{}';
select pg_temp.expect_error($q$select public.get_online_project_data('00000000-0000-4000-8000-000000000101')$q$,'ONLINE_DATA_AUTH_REQUIRED');
set local role anon;
select pg_temp.expect_error($q$select public.get_online_project_data('00000000-0000-4000-8000-000000000101')$q$,'permission denied');
reset role;
insert into public.online_project_workspaces(project_id,owner_id) values('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000001');
select pg_temp.expect_error($q$update public.online_project_workspaces set revision=1 where project_id='00000000-0000-4000-8000-000000000101'$q$,'ONLINE_DATA_MIGRATED');
rollback;
