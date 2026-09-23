-- Keep elevated access checks outside the exposed REST schema.
begin;
alter function public.get_online_project_access(uuid) set schema private;
create function public.get_online_project_access(p_project_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select * from private.get_online_project_access(p_project_id) $$;
revoke all on function public.get_online_project_access(uuid) from public,anon,authenticated;
grant execute on function public.get_online_project_access(uuid) to authenticated;
alter function public.list_online_projects(timestamptz,uuid) set schema private;
create function public.list_online_projects(p_before_time timestamptz default null,p_before_id uuid default null) returns setof jsonb
language sql security invoker set search_path='' as $$ select * from private.list_online_projects(p_before_time,p_before_id) $$;
revoke all on function public.list_online_projects(timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.list_online_projects(timestamptz,uuid) to authenticated;
alter function public.get_online_project_sharing(uuid) set schema private;
create function public.get_online_project_sharing(p_project_id uuid) returns jsonb
language sql security invoker set search_path='' as $$ select * from private.get_online_project_sharing(p_project_id) $$;
revoke all on function public.get_online_project_sharing(uuid) from public,anon,authenticated;
grant execute on function public.get_online_project_sharing(uuid) to authenticated;
alter function public.invite_online_project_member(uuid,text,text) set schema private;
create function public.invite_online_project_member(p_project_id uuid,p_email text,p_role text) returns uuid
language sql security invoker set search_path='' as $$ select * from private.invite_online_project_member(p_project_id,p_email,p_role) $$;
revoke all on function public.invite_online_project_member(uuid,text,text) from public,anon,authenticated;
grant execute on function public.invite_online_project_member(uuid,text,text) to authenticated;
alter function public.list_online_project_invitations() set schema private;
create function public.list_online_project_invitations() returns jsonb
language sql security invoker set search_path='' as $$ select * from private.list_online_project_invitations() $$;
revoke all on function public.list_online_project_invitations() from public,anon,authenticated;
grant execute on function public.list_online_project_invitations() to authenticated;
alter function public.respond_online_project_invitation(uuid,boolean) set schema private;
create function public.respond_online_project_invitation(p_invitation_id uuid,p_accept boolean) returns uuid
language sql security invoker set search_path='' as $$ select * from private.respond_online_project_invitation(p_invitation_id,p_accept) $$;
revoke all on function public.respond_online_project_invitation(uuid,boolean) from public,anon,authenticated;
grant execute on function public.respond_online_project_invitation(uuid,boolean) to authenticated;
alter function public.cancel_online_project_invitation(uuid) set schema private;
create function public.cancel_online_project_invitation(p_invitation_id uuid) returns void
language sql security invoker set search_path='' as $$ select * from private.cancel_online_project_invitation(p_invitation_id) $$;
revoke all on function public.cancel_online_project_invitation(uuid) from public,anon,authenticated;
grant execute on function public.cancel_online_project_invitation(uuid) to authenticated;
alter function public.update_online_project_member(uuid,uuid,text) set schema private;
create function public.update_online_project_member(p_project_id uuid,p_user_id uuid,p_role text) returns void
language sql security invoker set search_path='' as $$ select * from private.update_online_project_member(p_project_id,p_user_id,p_role) $$;
revoke all on function public.update_online_project_member(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.update_online_project_member(uuid,uuid,text) to authenticated;
commit;
