-- Recommended translation plugins shown in the desktop plugin page.
-- Each row is one complete SKILL.md; the app reads version and description from
-- its frontmatter. Maintainers edit rows with the service role (dashboard or SQL);
-- signed-in apps may only read published rows.
create table public.plugin_catalog (
  name text primary key
    check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$' and name not in ('translate-document', 'align-translation')),
  content text not null check (char_length(content) between 1 and 60000),
  sort_order integer not null default 0,
  published boolean not null default false
);

alter table public.plugin_catalog enable row level security;
revoke all on public.plugin_catalog from public, anon, authenticated;
grant all on public.plugin_catalog to service_role;
grant select on public.plugin_catalog to authenticated;
create policy plugin_catalog_published_read on public.plugin_catalog for select to authenticated
  using (published);
