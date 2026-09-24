-- Document summaries without extracted text.
-- Grant Factory loads every workspace document on each request. Extracted
-- text (content.blocks) is nearly all of that payload and is needed only when
-- one document is read, parsed or saved. This additive function returns the
-- same rows with blocks removed. It is server-only: the service role calls it
-- after the membership check; browser roles cannot execute it.
create or replace function public.gf_document_summaries(p_org uuid, p_after uuid default null, p_limit integer default 500)
returns table(id uuid, revision integer, updated_at timestamptz, content jsonb)
language sql stable security invoker set search_path = public, pg_temp as $$
  select d.id, d.revision, d.updated_at, d.content - 'blocks'
  from public.gf_documents d
  where d.org_id = p_org and (p_after is null or d.id > p_after)
  order by d.id
  limit least(greatest(coalesce(p_limit, 500), 1), 500)
$$;
revoke all on function public.gf_document_summaries(uuid, uuid, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.gf_document_summaries(uuid, uuid, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on function public.gf_document_summaries(uuid, uuid, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.gf_document_summaries(uuid, uuid, integer) to service_role;
  end if;
end $$;
