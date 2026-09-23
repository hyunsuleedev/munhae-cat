-- Bucket creation via SQL is supported by the official Creating Buckets guide.
-- Object upload/deletion must still use the Storage API, never metadata writes.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('online-project-workspaces', 'online-project-workspaces', false,
    52428800, array['application/zip']);
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.online_project_workspaces (
  project_id uuid primary key references public.online_projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  object_path text,
  sha256 text,
  byte_size bigint,
  lease_id uuid,
  fence bigint not null default 0 check (fence >= 0),
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((lease_id is null and lease_expires_at is null)
    or (lease_id is not null and lease_expires_at is not null and fence > 0)),
  check ((revision = 0 and object_path is null and sha256 is null and byte_size is null)
    or (revision > 0 and object_path is not null and sha256 is not null and sha256 ~ '^[0-9a-f]{64}$'
      and byte_size is not null and byte_size between 1 and 52428800))
);
create index online_project_workspaces_owner_idx on public.online_project_workspaces(owner_id);
alter table public.online_project_workspaces enable row level security;
revoke all on table public.online_project_workspaces from public, anon, authenticated;
grant select on table public.online_project_workspaces to authenticated;
create policy online_workspaces_owner_read on public.online_project_workspaces
  for select to authenticated using (owner_id = (select auth.uid()));

create function private.online_workspace_owner(p_project_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare
  owner uuid := auth.uid();
begin
  if owner is null or not exists (
    select 1 from public.online_projects p where p.id = p_project_id and p.owner_id = owner
  ) then
    raise exception using errcode = '42501', message = 'ONLINE_WORKSPACE_FORBIDDEN';
  end if;
  return owner;
end;
$$;

create function private.acquire_online_workspace(p_project_id uuid, p_lease_id uuid)
returns public.online_project_workspaces
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.online_workspace_owner(p_project_id);
  workspace public.online_project_workspaces;
  checked_at timestamptz;
begin
  if p_lease_id is null then
    raise exception using errcode = '22023', message = 'ONLINE_WORKSPACE_INVALID_LEASE';
  end if;
  insert into public.online_project_workspaces (project_id, owner_id)
    values (p_project_id, owner) on conflict (project_id) do nothing;
  select * into workspace from public.online_project_workspaces
    where project_id = p_project_id and owner_id = owner for update;
  if not found then
    raise exception using errcode = '42501', message = 'ONLINE_WORKSPACE_FORBIDDEN';
  end if;
  checked_at := clock_timestamp();
  if workspace.lease_id is not null and workspace.lease_expires_at > checked_at
    and workspace.lease_id <> p_lease_id then
    raise exception using errcode = 'P0001', message = 'ONLINE_WORKSPACE_LOCKED';
  end if;
  if workspace.lease_id is null or workspace.lease_expires_at <= checked_at then
    workspace.fence := workspace.fence + 1;
  end if;
  update public.online_project_workspaces set
    lease_id = p_lease_id, fence = workspace.fence,
    lease_expires_at = checked_at + interval '120 seconds'
    where project_id = p_project_id returning * into workspace;
  return workspace;
end;
$$;

create function private.renew_online_workspace(p_project_id uuid, p_lease_id uuid, p_fence bigint)
returns public.online_project_workspaces
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.online_workspace_owner(p_project_id);
  workspace public.online_project_workspaces;
  checked_at timestamptz;
begin
  select * into workspace from public.online_project_workspaces
    where project_id = p_project_id and owner_id = owner for update;
  checked_at := clock_timestamp();
  if not found or workspace.lease_id is distinct from p_lease_id
    or workspace.fence is distinct from p_fence or workspace.lease_expires_at is null
    or workspace.lease_expires_at <= checked_at then
    raise exception using errcode = 'P0001', message = 'ONLINE_WORKSPACE_LEASE_LOST';
  end if;
  update public.online_project_workspaces
    set lease_expires_at = checked_at + interval '120 seconds'
    where project_id = p_project_id returning * into workspace;
  return workspace;
end;
$$;

create function private.release_online_workspace(p_project_id uuid, p_lease_id uuid, p_fence bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.online_workspace_owner(p_project_id);
begin
  update public.online_project_workspaces set lease_id = null, lease_expires_at = null
    where project_id = p_project_id and owner_id = owner
      and lease_id = p_lease_id and fence = p_fence;
  return found;
end;
$$;

create function private.commit_online_workspace(
  p_project_id uuid, p_lease_id uuid, p_fence bigint, p_expected_revision bigint,
  p_object_path text, p_sha256 text, p_byte_size bigint
)
returns public.online_project_workspaces
language plpgsql security definer set search_path = '' as $$
declare
  owner uuid := private.online_workspace_owner(p_project_id);
  workspace public.online_project_workspaces;
  object_metadata jsonb;
  actual_size bigint;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_byte_size is null or p_byte_size not between 1 and 52428800
    or p_expected_revision is null or p_expected_revision < 0
    or p_fence is null or p_fence < 1 or p_object_path is null
    or p_object_path !~ ('^' || owner::text || '/' || p_project_id::text || '/' || p_fence::text
      || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.munhaepkg$') then
    raise exception using errcode = '22023', message = 'ONLINE_WORKSPACE_INVALID_CHECKPOINT';
  end if;
  select * into workspace from public.online_project_workspaces
    where project_id = p_project_id and owner_id = owner for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'ONLINE_WORKSPACE_LEASE_LOST';
  end if;
  -- A lost HTTP response may be retried after the lease has expired. Acknowledge
  -- the identical committed checkpoint without changing the new writer's state.
  if workspace.object_path = p_object_path and workspace.sha256 = p_sha256
    and workspace.byte_size = p_byte_size and workspace.revision = p_expected_revision + 1 then
    return workspace;
  end if;
  if workspace.lease_id is distinct from p_lease_id or workspace.fence <> p_fence
    or workspace.lease_expires_at is null or workspace.lease_expires_at <= clock_timestamp() then
    raise exception using errcode = 'P0001', message = 'ONLINE_WORKSPACE_LEASE_LOST';
  end if;
  if workspace.revision <> p_expected_revision or workspace.object_path = p_object_path then
    raise exception using errcode = '40001', message = 'ONLINE_WORKSPACE_CONFLICT';
  end if;
  select metadata into object_metadata from storage.objects
    where bucket_id = 'online-project-workspaces' and name = p_object_path;
  if not found then
    raise exception using errcode = 'P0001', message = 'ONLINE_WORKSPACE_CHECKPOINT_MISSING';
  end if;
  if coalesce(object_metadata->>'size', '') ~ '^[0-9]{1,16}$' then
    actual_size := (object_metadata->>'size')::bigint;
  end if;
  if actual_size is distinct from p_byte_size
    or object_metadata->>'mimetype' is distinct from 'application/zip' then
    raise exception using errcode = '22023', message = 'ONLINE_WORKSPACE_CHECKPOINT_INVALID';
  end if;
  -- Storage and Postgres cannot be committed atomically. Only completed immutable
  -- objects advance this pointer. Uncommitted objects remain harmless orphans;
  -- do not remove one after an ambiguous HTTP failure without checking this head.
  update public.online_project_workspaces set
    revision = revision + 1, object_path = p_object_path,
    sha256 = p_sha256, byte_size = p_byte_size, updated_at = clock_timestamp()
    where project_id = p_project_id returning * into workspace;
  update public.online_projects set updated_at = workspace.updated_at
    where id = p_project_id and owner_id = owner;
  return workspace;
end;
$$;

create function private.online_workspace_can_read(p_bucket text, p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_bucket = 'online-project-workspaces' and auth.uid() is not null
    and split_part(p_name, '/', 1) = auth.uid()::text
    and exists (select 1 from public.online_projects p
      where p.id::text = split_part(p_name, '/', 2) and p.owner_id = auth.uid());
$$;

create function private.online_workspace_can_upload(p_bucket text, p_name text, p_metadata jsonb)
returns boolean language sql volatile security definer set search_path = '' as $$
  select p_bucket = 'online-project-workspaces' and auth.uid() is not null
    and exists (select 1 from public.online_project_workspaces w
      join public.online_projects p on p.id = w.project_id and p.owner_id = w.owner_id
      where w.owner_id = auth.uid() and w.lease_expires_at > clock_timestamp()
        and w.lease_id::text = p_metadata->>'lease_id'
        and p_name ~ ('^' || w.owner_id::text || '/' || w.project_id::text || '/' || w.fence::text
          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.munhaepkg$'));
$$;

-- Keep the privileged implementations outside the exposed Data API schema.
create function public.acquire_online_workspace(p_project_id uuid, p_lease_id uuid)
returns public.online_project_workspaces language sql security invoker set search_path = '' as $$
  select private.acquire_online_workspace(p_project_id, p_lease_id);
$$;
create function public.renew_online_workspace(p_project_id uuid, p_lease_id uuid, p_fence bigint)
returns public.online_project_workspaces language sql security invoker set search_path = '' as $$
  select private.renew_online_workspace(p_project_id, p_lease_id, p_fence);
$$;
create function public.release_online_workspace(p_project_id uuid, p_lease_id uuid, p_fence bigint)
returns boolean language sql security invoker set search_path = '' as $$
  select private.release_online_workspace(p_project_id, p_lease_id, p_fence);
$$;
create function public.commit_online_workspace(
  p_project_id uuid, p_lease_id uuid, p_fence bigint, p_expected_revision bigint,
  p_object_path text, p_sha256 text, p_byte_size bigint
)
returns public.online_project_workspaces language sql security invoker set search_path = '' as $$
  select private.commit_online_workspace(p_project_id, p_lease_id, p_fence,
    p_expected_revision, p_object_path, p_sha256, p_byte_size);
$$;

revoke all on function private.online_workspace_owner(uuid) from public, anon, authenticated;
revoke all on function private.acquire_online_workspace(uuid,uuid) from public, anon, authenticated;
revoke all on function private.renew_online_workspace(uuid,uuid,bigint) from public, anon, authenticated;
revoke all on function private.release_online_workspace(uuid,uuid,bigint) from public, anon, authenticated;
revoke all on function private.commit_online_workspace(uuid,uuid,bigint,bigint,text,text,bigint) from public, anon, authenticated;
revoke all on function private.online_workspace_can_read(text,text) from public, anon, authenticated;
revoke all on function private.online_workspace_can_upload(text,text,jsonb) from public, anon, authenticated;
grant execute on function private.acquire_online_workspace(uuid,uuid),
  private.renew_online_workspace(uuid,uuid,bigint),
  private.release_online_workspace(uuid,uuid,bigint),
  private.commit_online_workspace(uuid,uuid,bigint,bigint,text,text,bigint),
  private.online_workspace_can_read(text,text),
  private.online_workspace_can_upload(text,text,jsonb) to authenticated;

revoke all on function public.acquire_online_workspace(uuid,uuid) from public, anon, authenticated;
revoke all on function public.renew_online_workspace(uuid,uuid,bigint) from public, anon, authenticated;
revoke all on function public.release_online_workspace(uuid,uuid,bigint) from public, anon, authenticated;
revoke all on function public.commit_online_workspace(uuid,uuid,bigint,bigint,text,text,bigint) from public, anon, authenticated;
grant execute on function public.acquire_online_workspace(uuid,uuid),
  public.renew_online_workspace(uuid,uuid,bigint),
  public.release_online_workspace(uuid,uuid,bigint),
  public.commit_online_workspace(uuid,uuid,bigint,bigint,text,text,bigint) to authenticated;

create policy online_workspace_objects_read on storage.objects for select to authenticated
  using (private.online_workspace_can_read(bucket_id, name));
create policy online_workspace_objects_insert on storage.objects for insert to authenticated
  with check (private.online_workspace_can_upload(bucket_id, name, user_metadata));
-- No UPDATE/upsert or DELETE policy: a late writer cannot overwrite or delete a
-- checkpoint referenced by a newer head. Cleanup must reconcile heads separately.
