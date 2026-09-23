-- Project access is separate from billing ownership. Existing projects stay private.
begin;
create table public.online_project_members (
 project_id uuid not null references public.online_projects(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check(role in ('editor','viewer')),
 joined_at timestamptz not null default now(), primary key(project_id,user_id)
);
create index online_project_members_user on public.online_project_members(user_id,project_id);
create table public.online_project_invitations (
 id uuid primary key default gen_random_uuid(), project_id uuid not null references public.online_projects(id) on delete cascade,
 email text not null check(email=lower(btrim(email)) and length(email)<=254 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
 role text not null check(role in ('editor','viewer')), status text not null default 'pending' check(status in ('pending','accepted','declined','cancelled','expired')),
 invited_by uuid not null references auth.users(id), accepted_by uuid references auth.users(id),
 created_at timestamptz not null default now(), expires_at timestamptz not null default (now()+interval '7 days'), responded_at timestamptz
);
create unique index online_project_pending_email on public.online_project_invitations(project_id,email) where status='pending';
create index online_project_invitation_email on public.online_project_invitations(email,status,expires_at);
alter table public.online_project_members enable row level security;
alter table public.online_project_invitations enable row level security;
revoke all on public.online_project_members,public.online_project_invitations from public,anon,authenticated;
grant select on public.online_project_members to authenticated;
-- The billing product is operator-configured, never supplied by an invitation client.
create table private.online_collaboration_plan (
 singleton boolean primary key default true check(singleton), stripe_account_id text not null,
 stripe_price_id text not null, livemode boolean not null, member_limit integer not null check(member_limit=5)
);
insert into private.online_collaboration_plan values(true,'acct_1UEFAWA3GOt8qQ7V','price_1UIo0vA3GOt8qQ7V5uVosHAW',true,5);
alter table private.online_collaboration_plan enable row level security;
revoke all on private.online_collaboration_plan from public,anon,authenticated;
grant all on private.online_collaboration_plan to service_role;

create function private.online_project_role(p_project_id uuid) returns text
language sql stable security definer set search_path='' as $$
 select case when p.owner_id=auth.uid() then 'owner' else m.role end
 from public.online_projects p left join public.online_project_members m on m.project_id=p.id and m.user_id=auth.uid()
 where p.id=p_project_id and auth.uid() is not null
$$;
revoke all on function private.online_project_role(uuid) from public,anon,authenticated;
grant execute on function private.online_project_role(uuid) to authenticated;
create function private.online_verified_email() returns text language sql stable security definer set search_path='' as $$
 select lower(email) from auth.users where id=auth.uid() and email_confirmed_at is not null and coalesce(is_anonymous,false)=false
$$;
revoke all on function private.online_verified_email() from public,anon,authenticated;
create function private.online_collaboration_premium(p_owner uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.billing_subscriptions s join private.online_collaboration_plan c
 on s.stripe_account_id=c.stripe_account_id and s.stripe_price_id=c.stripe_price_id and s.livemode=c.livemode
 where s.user_id=p_owner and s.status in ('active','trialing') and s.current_period_end>now())
$$;
revoke all on function private.online_collaboration_premium(uuid) from public,anon,authenticated;
create policy members_read on public.online_project_members for select to authenticated using(private.online_project_role(project_id) is not null);
drop policy online_projects_owner_read on public.online_projects;
create policy online_projects_access_read on public.online_projects for select to authenticated using(private.online_project_role(id) is not null);
drop policy online_project_data_owner on public.online_project_data;
create policy online_project_data_access on public.online_project_data for select to authenticated using(private.online_project_role(project_id) is not null);
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='public' and starts_with(tablename,'online_data_') loop
  execute format('drop policy owner_select on public.%I',t.tablename);
  execute format('create policy member_select on public.%I for select to authenticated using(private.online_project_role(online_project_id) is not null)',t.tablename);
 end loop;
end $$;
-- Read RPCs use this historical helper. The write RPC below has a separate check.
create or replace function private.online_data_assert_owner(p_project_id uuid) returns void
language plpgsql security definer set search_path='' as $$ begin
 if auth.uid() is null or private.online_project_role(p_project_id) is null then raise exception 'ONLINE_DATA_NOT_FOUND' using errcode='42501'; end if;
end $$;

create function public.get_online_project_access(p_project_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.online_projects; r text; begin
 select * into p from public.online_projects where id=p_project_id;
 r:=private.online_project_role(p_project_id);
 if r is null then raise exception 'ONLINE_DATA_NOT_FOUND' using errcode='42501'; end if;
 return to_jsonb(p)-'request_id'||jsonb_build_object('role',r);
end $$;
create function public.list_online_projects(p_before_time timestamptz default null,p_before_id uuid default null) returns setof jsonb
language sql stable security definer set search_path='' as $$
 select to_jsonb(p)-'request_id'||jsonb_build_object('role',private.online_project_role(p.id)) from public.online_projects p
 where private.online_project_role(p.id) is not null and (p_before_time is null or (p.created_at,p.id)<(p_before_time,p_before_id))
 order by p.created_at desc,p.id desc limit 200
$$;
create function public.get_online_project_sharing(p_project_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.online_projects; r text; members jsonb; invites jsonb; seats integer; begin
 select * into p from public.online_projects where id=p_project_id;
 r:=private.online_project_role(p_project_id);
 if r is null then raise exception 'ONLINE_DATA_NOT_FOUND' using errcode='42501'; end if;
 select coalesce(jsonb_agg(x order by x->>'role',x->>'email'),'[]') into members from (
 select jsonb_build_object('userId',u.id,'email',case when r='owner' or u.id=auth.uid() then u.email else null end,
 'displayName',coalesce(nullif(u.raw_user_meta_data->>'full_name',''),nullif(u.raw_user_meta_data->>'name',''),'멤버'),'role','owner') x from auth.users u where u.id=p.owner_id
 union all select jsonb_build_object('userId',u.id,'email',case when r='owner' or u.id=auth.uid() then u.email else null end,
 'displayName',coalesce(nullif(u.raw_user_meta_data->>'full_name',''),nullif(u.raw_user_meta_data->>'name',''),'멤버'),'role',m.role)
 from public.online_project_members m join auth.users u on u.id=m.user_id where m.project_id=p_project_id) q;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'role',role,'expiresAt',expires_at) order by created_at),'[]') into invites
 from public.online_project_invitations where project_id=p_project_id and status='pending' and expires_at>now();
 seats:=jsonb_array_length(members)+jsonb_array_length(invites);
 return jsonb_build_object('projectId',p.id,'role',r,'members',members,'invitations',case when r='owner' then invites else '[]'::jsonb end,
 'usedSeats',seats,'memberLimit',5,'canInvite',r='owner' and private.online_collaboration_premium(p.owner_id),'initialized',exists(select 1 from public.online_project_data where project_id=p.id and revision>0));
end $$;
create function public.invite_online_project_member(p_project_id uuid,p_email text,p_role text) returns uuid
language plpgsql security definer set search_path='' as $$
declare p public.online_projects; e text:=lower(btrim(p_email)); existing uuid; seats integer; begin
 select * into p from public.online_projects where id=p_project_id for update;
 if not found or p.owner_id is distinct from auth.uid() then raise exception 'COLLAB_OWNER_REQUIRED' using errcode='42501'; end if;
 if not private.online_collaboration_premium(p.owner_id) then raise exception 'COLLAB_PREMIUM_REQUIRED' using errcode='42501'; end if;
 if not exists(select 1 from public.online_project_data where project_id=p.id and revision>0) then raise exception 'COLLAB_OPEN_PROJECT_FIRST' using errcode='22023'; end if;
 if p_role is null or p_role not in ('editor','viewer') or e is null or length(e)>254 or e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'COLLAB_INVALID_INVITE' using errcode='22023'; end if;
 if exists(select 1 from auth.users u where lower(u.email)=e and (u.id=p.owner_id or exists(select 1 from public.online_project_members m where m.project_id=p.id and m.user_id=u.id))) then raise exception 'COLLAB_ALREADY_MEMBER' using errcode='23505'; end if;
 update public.online_project_invitations set status='expired',responded_at=now() where project_id=p.id and status='pending' and expires_at<=now();
 select id into existing from public.online_project_invitations where project_id=p.id and email=e and status='pending';
 if existing is not null then
  if exists(select 1 from public.online_project_invitations where id=existing and role=p_role) then return existing; end if;
  raise exception 'COLLAB_INVITE_EXISTS' using errcode='23505';
 end if;
 select 1+(select count(*) from public.online_project_members where project_id=p.id)+(select count(*) from public.online_project_invitations where project_id=p.id and status='pending' and expires_at>now()) into seats;
 if seats>=5 then raise exception 'COLLAB_MEMBER_LIMIT' using errcode='23514'; end if;
 insert into public.online_project_invitations(project_id,email,role,invited_by) values(p.id,e,p_role,auth.uid()) returning id into existing;
 return existing;
end $$;
create function public.list_online_project_invitations() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'projectId',p.id,'projectTitle',p.title,'role',i.role,'expiresAt',i.expires_at) order by i.created_at desc),'[]')
 from public.online_project_invitations i join public.online_projects p on p.id=i.project_id
 where i.email=private.online_verified_email() and i.status='pending' and i.expires_at>now()
$$;
create function public.respond_online_project_invitation(p_invitation_id uuid,p_accept boolean) returns uuid
language plpgsql security definer set search_path='' as $$
declare i public.online_project_invitations; p public.online_projects; e text:=private.online_verified_email(); seats integer; begin
 select * into i from public.online_project_invitations where id=p_invitation_id;
 if e is null or i.email is distinct from e or p_accept is null then raise exception 'COLLAB_INVITE_NOT_FOUND' using errcode='42501'; end if;
 select * into p from public.online_projects where id=i.project_id for update;
 select * into i from public.online_project_invitations where id=p_invitation_id for update;
 if p_accept and i.status='accepted' and i.accepted_by=auth.uid() and exists(select 1 from public.online_project_members where project_id=p.id and user_id=auth.uid()) then return p.id; end if;
 if i.status<>'pending' or i.expires_at<=now() then raise exception 'COLLAB_INVITE_EXPIRED' using errcode='22023'; end if;
 if p_accept then
  if not private.online_collaboration_premium(p.owner_id) then raise exception 'COLLAB_PREMIUM_REQUIRED' using errcode='42501'; end if;
  select 1+(select count(*) from public.online_project_members where project_id=p.id)+(select count(*) from public.online_project_invitations where project_id=p.id and status='pending' and expires_at>now()) into seats;
  if seats>5 then raise exception 'COLLAB_MEMBER_LIMIT' using errcode='23514'; end if;
  if p.owner_id=auth.uid() then raise exception 'COLLAB_ALREADY_MEMBER' using errcode='23505'; end if;
  insert into public.online_project_members(project_id,user_id,role) values(p.id,auth.uid(),i.role) on conflict(project_id,user_id) do nothing;
 end if;
 update public.online_project_invitations set status=case when p_accept then 'accepted' else 'declined' end,accepted_by=case when p_accept then auth.uid() else null end,responded_at=now() where id=i.id;
 return p.id;
end $$;
create function public.cancel_online_project_invitation(p_invitation_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare pid uuid; begin
 select project_id into pid from public.online_project_invitations where id=p_invitation_id;
 perform 1 from public.online_projects where id=pid and owner_id=auth.uid() for update;
 if not found then raise exception 'COLLAB_OWNER_REQUIRED' using errcode='42501'; end if;
 update public.online_project_invitations set status='cancelled',responded_at=now() where id=p_invitation_id and status='pending';
end $$;
create function public.update_online_project_member(p_project_id uuid,p_user_id uuid,p_role text) returns void language plpgsql security definer set search_path='' as $$
declare p public.online_projects; begin
 select * into p from public.online_projects where id=p_project_id for update;
 if not found or p.owner_id is distinct from auth.uid() then raise exception 'COLLAB_OWNER_REQUIRED' using errcode='42501'; end if;
 if p_user_id=p.owner_id then raise exception 'COLLAB_OWNER_IMMUTABLE' using errcode='42501'; end if;
 if p_role is null then delete from public.online_project_members where project_id=p.id and user_id=p_user_id;
 elsif p_role in ('editor','viewer') then update public.online_project_members set role=p_role where project_id=p.id and user_id=p_user_id;
 else raise exception 'COLLAB_INVALID_ROLE' using errcode='22023'; end if;
end $$;
-- Preserve the validated commit engine, but make its old entry point server-only.
alter function private.commit_online_project_data(uuid,bigint,uuid,integer,jsonb,uuid,bigint) rename to commit_online_project_data_v1;
revoke all on function private.commit_online_project_data_v1(uuid,bigint,uuid,integer,jsonb,uuid,bigint) from public,anon,authenticated;
-- The original commit validated assets under auth.uid(); shared writers use the owner's namespace.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('private.commit_online_project_data_v1(uuid,bigint,uuid,integer,jsonb,uuid,bigint)'::regprocedure);
 if strpos(definition,'name=auth.uid()::text')=0 then raise exception 'Unexpected asset validation definition'; end if;
 definition:=replace(definition,'name=auth.uid()::text','name=(select owner_id::text from public.online_projects where id=p_project_id)');
 execute definition;
end $$;
create function private.commit_online_project_data(p_project_id uuid,p_expected_revision bigint,p_mutation_id uuid,p_schema_version integer,p_changes jsonb,p_legacy_lease_id uuid default null,p_legacy_fence bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r text; c jsonb; begin
 -- Preserve the legacy lease -> project lock order during the owner-only first commit.
 if p_expected_revision=0 then perform 1 from public.online_project_workspaces where project_id=p_project_id for update; end if;
 -- Member changes and writes serialize on the same project row.
 perform 1 from public.online_projects where id=p_project_id for update;
 r:=private.online_project_role(p_project_id);
 if r is null or r not in ('owner','editor') then raise exception 'COLLAB_WRITE_REQUIRED' using errcode='42501'; end if;
 if r='editor' then
  if p_expected_revision=0 then raise exception 'COLLAB_OWNER_REQUIRED' using errcode='42501'; end if;
  for c in select value from jsonb_array_elements(p_changes) loop
   if c->>'table' in ('core_projects','core_project_settings') or
    (c->>'table'='punctuation_structure_spans' and exists(select 1 from public.online_data_punctuation_versions v where v.online_project_id=p_project_id and v.state='confirmed' and v.id in (c->'before'->>'punctuation_version_id',c->'after'->>'punctuation_version_id'))) or
    (c->>'table' in ('translation_blocks','translation_text_layouts') and exists(select 1 from public.online_data_document_translation_versions v where v.online_project_id=p_project_id and v.state='confirmed' and v.id in (c->'before'->>'document_translation_version_id',c->'after'->>'document_translation_version_id',c->'before'->>'version_id',c->'after'->>'version_id'))) or
    (c->>'table'='translation_block_anchors' and exists(select 1 from public.online_data_translation_blocks b join public.online_data_document_translation_versions v on v.online_project_id=b.online_project_id and v.id=b.document_translation_version_id where b.online_project_id=p_project_id and v.state='confirmed' and b.id in (c->'before'->>'translation_block_id',c->'after'->>'translation_block_id'))) or
    (c->'after'->>'confirmed_version_id') is distinct from (c->'before'->>'confirmed_version_id') or
    (c->'after'->>'state'='confirmed' and c->'after' is distinct from c->'before') or
    (c->'before'->>'state'='confirmed' and c->'after' is distinct from c->'before') then
    raise exception 'COLLAB_CONFIRM_OWNER_REQUIRED' using errcode='42501';
   end if;
  end loop;
 end if;
 return private.commit_online_project_data_v1(p_project_id,p_expected_revision,p_mutation_id,p_schema_version,p_changes,p_legacy_lease_id,p_legacy_fence);
end $$;
revoke all on function private.commit_online_project_data(uuid,bigint,uuid,integer,jsonb,uuid,bigint) from public,anon,authenticated;
grant execute on function private.commit_online_project_data(uuid,bigint,uuid,integer,jsonb,uuid,bigint) to authenticated;
-- SQL-function bodies are strings; explicitly rebind the public entry point.
create or replace function public.commit_online_project_data(p_project_id uuid,p_expected_revision bigint,p_mutation_id uuid,p_schema_version integer,p_changes jsonb,p_legacy_lease_id uuid default null,p_legacy_fence bigint default null) returns jsonb language sql security invoker set search_path='' as $$ select private.commit_online_project_data(p_project_id,p_expected_revision,p_mutation_id,p_schema_version,p_changes,p_legacy_lease_id,p_legacy_fence) $$;
-- All members use the existing owner's immutable asset namespace.
create function private.online_asset_access(p_name text,p_write boolean) returns boolean language plpgsql stable security definer set search_path='' as $$
declare pid uuid; r text; begin
 if p_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}$' then return false; end if;
 begin pid:=split_part(p_name,'/',2)::uuid; exception when invalid_text_representation then return false; end;
 r:=private.online_project_role(pid);
 return r is not null and (not p_write or r in ('owner','editor')) and exists(select 1 from public.online_projects where id=pid and owner_id::text=split_part(p_name,'/',1));
end $$;
revoke all on function private.online_asset_access(text,boolean) from public,anon,authenticated;
grant execute on function private.online_asset_access(text,boolean) to authenticated;
drop policy online_assets_owner_select on storage.objects;
drop policy online_assets_owner_insert on storage.objects;
create policy online_assets_member_select on storage.objects for select to authenticated using(bucket_id='online-project-assets' and private.online_asset_access(name,false));
create policy online_assets_editor_insert on storage.objects for insert to authenticated with check(bucket_id='online-project-assets' and private.online_asset_access(name,true));

do $$ declare f regprocedure; begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('get_online_project_access','list_online_projects','get_online_project_sharing','invite_online_project_member','list_online_project_invitations','respond_online_project_invitation','cancel_online_project_invitation','update_online_project_member') loop
 execute format('revoke all on function %s from public,anon,authenticated',f);
 execute format('grant execute on function %s to authenticated',f);
 end loop;
end $$;
commit;
