-- Run this script once in the SQL Editor for EACH Supabase project:
--   1. Opportunity Assist
--   2. Classroom Credit Score

create table if not exists public.healthcheck (
  id smallint primary key,
  label text not null default 'ok'
);

alter table public.healthcheck enable row level security;

grant select on table public.healthcheck to anon;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'healthcheck'
      and policyname = 'Allow anonymous health check reads'
  ) then
    create policy "Allow anonymous health check reads"
      on public.healthcheck
      for select
      to anon
      using (id = 1);
  end if;
end
$$;

insert into public.healthcheck (id, label)
values (1, 'ok')
on conflict (id) do update set label = excluded.label;
