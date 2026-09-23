-- Online project metadata is separate from local .munhae projects and community data.
create table public.online_projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Match JavaScript trim(), including tabs, non-breaking and ideographic spaces.
  title text not null check (
    title = btrim(title, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and char_length(title) between 1 and 160
    and title !~ E'[\r\n]'
  ),
  description text not null default '' check (char_length(description) <= 4000),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint online_projects_owner_request_key unique (owner_id, request_id)
);

create index online_projects_owner_created_idx
  on public.online_projects (owner_id, created_at desc, id desc);

alter table public.online_projects enable row level security;

create policy online_projects_owner_read on public.online_projects
  for select to authenticated
  using (owner_id = (select auth.uid()));

create policy online_projects_owner_create on public.online_projects
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- Revoke Supabase's legacy defaults explicitly. Owners and server timestamps cannot
-- be supplied by a client, and this first version has no update or delete API.
revoke all on table public.online_projects from public, anon, authenticated;
grant select on table public.online_projects to authenticated;
grant insert (title, description, request_id) on public.online_projects to authenticated;

create function public.create_online_project(
  p_title text,
  p_description text,
  p_request_id uuid
)
returns public.online_projects
language plpgsql
security invoker
set search_path = ''
as $$
declare
  project public.online_projects;
  project_owner uuid := auth.uid();
  trim_characters constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
  project_title text := btrim(p_title, trim_characters);
  project_description text := btrim(coalesce(p_description, ''), trim_characters);
begin
  if project_owner is null then
    raise exception using errcode = '42501', message = 'ONLINE_PROJECT_AUTH_REQUIRED';
  end if;
  if project_title is null or char_length(project_title) not between 1 and 160
    or project_title ~ E'[\r\n]' then
    raise exception using errcode = '22023', message = 'ONLINE_PROJECT_INVALID_TITLE';
  end if;
  if char_length(project_description) > 4000 then
    raise exception using errcode = '22023', message = 'ONLINE_PROJECT_INVALID_DESCRIPTION';
  end if;
  if p_request_id is null then
    raise exception using errcode = '22023', message = 'ONLINE_PROJECT_INVALID_REQUEST';
  end if;

  insert into public.online_projects (title, description, request_id)
  values (project_title, project_description, p_request_id)
  on conflict (owner_id, request_id) do nothing
  returning * into project;

  if found then
    return project;
  end if;

  -- This separate statement gets a fresh READ COMMITTED snapshot after waiting
  -- for a concurrent request's unique-key conflict to finish committing.
  select * into project
  from public.online_projects
  where owner_id = project_owner and request_id = p_request_id;

  if not found then
    raise exception using errcode = '40001', message = 'ONLINE_PROJECT_RETRY_REQUIRED';
  end if;
  if project.title is distinct from project_title
    or project.description is distinct from project_description then
    raise exception using errcode = '23505', message = 'ONLINE_PROJECT_REQUEST_CONFLICT';
  end if;
  return project;
end;
$$;

revoke all on function public.create_online_project(text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_online_project(text, text, uuid) to authenticated;
