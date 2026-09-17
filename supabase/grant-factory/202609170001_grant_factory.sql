-- Additive Phase 1 migration. Apply after the existing Opportunity Assist core schema.
-- No existing organizations, profiles, opportunities or Director records are changed.
begin;
create table if not exists public.gf_workspaces (
 org_id uuid primary key references public.organizations(id),
 brain_revision integer not null default 0,
 voice text not null default 'Natural, human, credible, practical, community-rooted, direct and professional. No exaggerated claims, jargon, em dashes or repetitive endings.',
 created_at timestamptz not null default now()
);
create table if not exists public.gf_members (
 org_id uuid not null references public.gf_workspaces(org_id),
 user_id uuid not null references public.profiles(id),
 role text not null check (role in ('OWNER','GRANT_MANAGER')),
 primary key(org_id,user_id)
);
create or replace function public.gf_role(p_org uuid) returns text
language sql stable security definer set search_path=public,pg_temp as $$
 select role from public.gf_members where org_id=p_org and user_id=auth.uid()
$$;
revoke all on function public.gf_role(uuid) from public;
grant execute on function public.gf_role(uuid) to authenticated,service_role;

create table if not exists public.gf_programs (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.gf_workspaces,
 content jsonb not null, revision integer not null default 1,
 updated_at timestamptz not null default now(), unique(org_id,id)
);
create table if not exists public.gf_documents (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.gf_workspaces,
 content jsonb not null, revision integer not null default 1,
 updated_at timestamptz not null default now(), unique(org_id,id)
);
create table if not exists public.gf_facts (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.gf_workspaces,
 content jsonb not null, revision integer not null default 1,
 updated_at timestamptz not null default now(), unique(org_id,id)
);
create unique index if not exists gf_seed_fact on public.gf_facts(org_id,(content->>'seed_key')) where content->>'seed_key' is not null;
create unique index if not exists gf_seed_program on public.gf_programs(org_id,(content->>'seed_key')) where content->>'seed_key' is not null;
create unique index if not exists gf_seed_document on public.gf_documents(org_id,(content->>'seed_key')) where content->>'seed_key' is not null;
create table if not exists public.gf_applications (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.gf_workspaces,
 opportunity_id uuid references public.opportunities(id),
 content jsonb not null, revision integer not null default 1,
 updated_at timestamptz not null default now(), unique(org_id,id)
);
create table if not exists public.gf_questions (
 id uuid primary key, org_id uuid not null, application_id uuid not null,
 position integer not null, content jsonb not null,
 foreign key(org_id,application_id) references public.gf_applications(org_id,id),
 unique(org_id,application_id,id)
);
create table if not exists public.gf_answers (
 id uuid primary key, org_id uuid not null, application_id uuid not null, question_id uuid not null,
 content jsonb not null,
 foreign key(org_id,application_id,question_id) references public.gf_questions(org_id,application_id,id),
 unique(org_id,application_id,question_id)
);
create table if not exists public.gf_history (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.gf_workspaces,
 entity_id uuid not null, entity_type text not null, actor_id uuid not null,
 event_type text not null, revision integer not null, content jsonb not null,
 created_at timestamptz not null default now()
);
create table if not exists public.gf_snapshots (
 id uuid primary key default gen_random_uuid(), org_id uuid not null, application_id uuid not null,
 actor_id uuid not null, revision integer not null, content jsonb not null,
 created_at timestamptz not null default now(),
 foreign key(org_id,application_id) references public.gf_applications(org_id,id),
 unique(org_id,application_id,revision)
);
create table if not exists public.gf_ai_runs (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references public.gf_workspaces,
 actor_id uuid not null, task text not null, status text not null default 'RUNNING',
 model text, input_tokens integer, output_tokens integer, error text,
 created_at timestamptz not null default now(), completed_at timestamptz
);
create index if not exists gf_ai_daily on public.gf_ai_runs(org_id,created_at);
create index if not exists gf_application_org on public.gf_applications(org_id,updated_at desc);
create index if not exists gf_question_application on public.gf_questions(org_id,application_id);
create index if not exists gf_answer_application on public.gf_answers(org_id,application_id);
create index if not exists gf_history_entity on public.gf_history(org_id,entity_id,created_at desc);

-- Clients can read only through their explicitly provisioned Grant Factory membership.
-- Mutations run through the authenticated server endpoint, never arbitrary browser writes.
do $$ declare t text; begin
 foreach t in array array['gf_workspaces','gf_members','gf_programs','gf_documents','gf_facts','gf_applications','gf_questions','gf_answers','gf_history','gf_snapshots','gf_ai_runs'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('grant all on public.%I to service_role',t);
  execute format('drop policy if exists gf_member_read on public.%I',t);
  if t in ('gf_documents','gf_facts') then
   execute format('create policy gf_member_read on public.%I for select to authenticated using (public.gf_role(org_id) is not null and (coalesce(content->>''sensitivity_level'',''INTERNAL'') <> ''RESTRICTED'' or public.gf_role(org_id) = ''OWNER''))',t);
  elsif t in ('gf_history','gf_snapshots') then
   -- Full history/snapshots may include formerly restricted evidence. Server redacts for managers.
   execute format('create policy gf_member_read on public.%I for select to authenticated using (public.gf_role(org_id) = ''OWNER'')',t);
  else
   execute format('create policy gf_member_read on public.%I for select to authenticated using (public.gf_role(org_id) is not null)',t);
  end if;
 end loop;
end $$;

create or replace function public.gf_immutable() returns trigger language plpgsql as $$
begin raise exception 'Grant Factory history and submission snapshots are immutable'; end $$;
drop trigger if exists gf_history_immutable on public.gf_history;
create trigger gf_history_immutable before update or delete on public.gf_history for each row execute function public.gf_immutable();
drop trigger if exists gf_snapshot_immutable on public.gf_snapshots;
create trigger gf_snapshot_immutable before update or delete on public.gf_snapshots for each row execute function public.gf_immutable();

-- An organization lock serializes truth changes with approval/snapshot creation.
create or replace function public.gf_write_brain(p_org uuid,p_actor uuid,p_expected integer,p_changes jsonb) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare ver integer; member_role text; item jsonb; oldrow jsonb; row_id uuid; tab text; newrev integer; affected integer;
begin
 select role into member_role from gf_members where org_id=p_org and user_id=p_actor;
 if member_role is null then raise exception 'Membership required'; end if;
 select brain_revision into ver from gf_workspaces where org_id=p_org for update;
 if ver is distinct from p_expected then raise exception 'Revision conflict'; end if;
 for item in select value from jsonb_array_elements(p_changes) loop
  tab:=item->>'table'; row_id:=(item->>'id')::uuid;
  if tab not in ('gf_facts','gf_programs','gf_documents') then raise exception 'Invalid brain entity'; end if;
  if member_role <> 'OWNER' and tab <> 'gf_documents' then
   if coalesce(item->'content'->>'verification_status','DRAFT') <> 'NEEDS_VERIFICATION'
      or coalesce((item->'content'->>'grant_use_allowed')::boolean,false)
      or coalesce((item->'content'->>'external_use_allowed')::boolean,false) then raise exception 'Owner approval required'; end if;
  end if;
  execute format('select to_jsonb(t) from %I t where org_id=$1 and id=$2',tab) into oldrow using p_org,row_id;
  if member_role <> 'OWNER' and oldrow is not null and (oldrow->'content'->>'verification_status' in ('APPROVED','VERIFIED','PROJECTED','DERIVED') or oldrow->'content'->>'sensitivity_level'='RESTRICTED') then raise exception 'Owner approval required'; end if;
  newrev:=coalesce((oldrow->>'revision')::integer,0)+1;
  execute format('insert into %I(id,org_id,content,revision) values($1,$2,$3,$4) on conflict(id) do update set content=excluded.content,revision=excluded.revision,updated_at=now() where %I.org_id=excluded.org_id',tab,tab)
   using row_id,p_org,item->'content',newrev;
  get diagnostics affected = row_count;
  if affected = 0 then raise exception 'Entity organization mismatch'; end if;
  insert into gf_history(org_id,entity_id,entity_type,actor_id,event_type,revision,content)
   values(p_org,row_id,tab,p_actor,'BRAIN_EDIT',newrev,jsonb_build_object('before',oldrow,'after',item->'content'));
 end loop;
 update gf_workspaces set brain_revision=brain_revision+1 where org_id=p_org returning brain_revision into ver;
 return ver;
end $$;

create or replace function public.gf_save_application(p_org uuid,p_actor uuid,p_id uuid,p_expected integer,p_brain_revision integer,p_record jsonb,p_questions jsonb,p_answers jsonb,p_event text,p_snapshot jsonb default null) returns integer
language plpgsql security definer set search_path=public,pg_temp as $$
declare ver integer; current_brain integer; member_role text; oldrow jsonb; item jsonb; pos integer:=0;
begin
 select role into member_role from gf_members where org_id=p_org and user_id=p_actor;
 if member_role is null then raise exception 'Membership required'; end if;
 select brain_revision into current_brain from gf_workspaces where org_id=p_org for update;
 if current_brain is distinct from p_brain_revision then raise exception 'Truth changed; refresh and rerun review'; end if;
 select to_jsonb(t),revision into oldrow,ver from gf_applications t where org_id=p_org and id=p_id for update;
 if coalesce(ver,0) <> p_expected then raise exception 'Revision conflict'; end if;
 if oldrow->'content'->>'status' in ('SUBMITTED','ARCHIVED') then raise exception 'Submitted applications are immutable; create a new application'; end if;
 if (p_record->>'status' in ('APPROVED','READY_TO_SUBMIT','SUBMITTED') or p_snapshot is not null) and member_role <> 'OWNER' then raise exception 'Owner approval required'; end if;
 if p_snapshot is not null and (oldrow->'content'->>'status' <> 'APPROVED' or p_record->>'status' <> 'SUBMITTED') then raise exception 'Approved application required'; end if;
 ver:=coalesce(ver,0)+1;
 insert into gf_applications(id,org_id,opportunity_id,content,revision) values(p_id,p_org,nullif(p_record->>'opportunity_id','')::uuid,p_record,ver)
 on conflict(id) do update set content=excluded.content,opportunity_id=excluded.opportunity_id,revision=excluded.revision,updated_at=now() where gf_applications.org_id=excluded.org_id;
 if not found then raise exception 'Application organization mismatch'; end if;
 -- Replace the child set inside this transaction; history retains every prior answer/version.
 delete from gf_answers where org_id=p_org and application_id=p_id;
 delete from gf_questions where org_id=p_org and application_id=p_id;
 for item in select value from jsonb_array_elements(p_questions) loop
  insert into gf_questions(id,org_id,application_id,position,content) values((item->>'id')::uuid,p_org,p_id,pos,item); pos:=pos+1;
 end loop;
 for item in select value from jsonb_array_elements(p_answers) loop
  insert into gf_answers(id,org_id,application_id,question_id,content) values((item->>'id')::uuid,p_org,p_id,(item->>'question_id')::uuid,item);
 end loop;
 insert into gf_history(org_id,entity_id,entity_type,actor_id,event_type,revision,content)
 values(p_org,p_id,'application',p_actor,p_event,ver,jsonb_build_object('application',p_record,'questions',p_questions,'answers',p_answers,'brain_revision',current_brain));
 if p_snapshot is not null then
  insert into gf_snapshots(org_id,application_id,actor_id,revision,content) values(p_org,p_id,p_actor,ver,p_snapshot);
 end if;
 return ver;
end $$;

create or replace function public.gf_begin_ai_run(p_org uuid,p_actor uuid,p_task text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare run_id uuid; begin
 if not exists(select 1 from gf_members where org_id=p_org and user_id=p_actor) then raise exception 'Membership required'; end if;
 perform 1 from gf_workspaces where org_id=p_org for update;
 if (select count(*) from gf_ai_runs where org_id=p_org and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') >= 120 then raise exception 'Daily AI run limit reached'; end if;
 if (select count(*) from gf_ai_runs where org_id=p_org and status='RUNNING' and created_at>now()-interval '2 minutes') >= 4 then raise exception 'AI work is already running; try again shortly'; end if;
 insert into gf_ai_runs(org_id,actor_id,task) values(p_org,p_actor,p_task) returning id into run_id; return run_id;
end $$;
revoke all on function public.gf_write_brain(uuid,uuid,integer,jsonb) from public,anon,authenticated;
revoke all on function public.gf_save_application(uuid,uuid,uuid,integer,integer,jsonb,jsonb,jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.gf_begin_ai_run(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.gf_write_brain(uuid,uuid,integer,jsonb) to service_role;
grant execute on function public.gf_save_application(uuid,uuid,uuid,integer,integer,jsonb,jsonb,jsonb,text,jsonb) to service_role;
grant execute on function public.gf_begin_ai_run(uuid,uuid,text) to service_role;
commit;
