-- Supabase can explicitly grant new functions to anon through default privileges.
-- Revoking PUBLIC alone does not remove that independent grant.
revoke all on function public.gf_role(uuid) from public,anon;
grant execute on function public.gf_role(uuid) to authenticated,service_role;
alter function public.gf_immutable() set search_path=public,pg_temp;
revoke all on function public.gf_immutable() from public,anon,authenticated;
