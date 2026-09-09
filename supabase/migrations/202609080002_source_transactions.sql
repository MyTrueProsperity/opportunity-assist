begin;
create or replace function public.source_ingest_candidate(p_candidate jsonb,p_sighting jsonb) returns jsonb
language plpgsql security invoker set search_path=public as $f$
declare c public.source_candidates;
begin
 insert into source_candidates(identity_key,source_name,source_url,normalized_url,state_code,proposed,scores,duplicate_matches,duplicate_outcome,matched_program_id,reason,reason_code,quality_ready,discovery_method,first_run_id,last_verified_at)
 values(p_candidate->>'identity_key',p_candidate->>'source_name',p_candidate->>'source_url',p_candidate->>'normalized_url',p_candidate->>'state_code',coalesce(p_candidate->'proposed','{}'),coalesce(p_candidate->'scores','{}'),coalesce(p_candidate->'duplicate_matches','[]'),coalesce(p_candidate->>'duplicate_outcome','POSSIBLE_DUPLICATE_REVIEW'),(p_candidate->>'matched_program_id')::uuid,p_candidate->>'reason',p_candidate->>'reason_code',coalesce((p_candidate->>'quality_ready')::boolean,false),p_candidate->>'discovery_method',(p_candidate->>'first_run_id')::uuid,(p_candidate->>'last_verified_at')::timestamptz)
 on conflict(identity_key) do update set last_seen_at=now() returning * into c;
 -- A new observation never reopens or overwrites a human decision.
 if c.status in('PENDING','INVESTIGATING','MATCHED') and p_candidate ? 'last_verified_at' then
   update source_candidates set proposed=p_candidate->'proposed',scores=p_candidate->'scores',duplicate_matches=p_candidate->'duplicate_matches',duplicate_outcome=p_candidate->>'duplicate_outcome',matched_program_id=(p_candidate->>'matched_program_id')::uuid,quality_ready=(p_candidate->>'quality_ready')::boolean,reason=p_candidate->>'reason',reason_code=p_candidate->>'reason_code',last_verified_at=(p_candidate->>'last_verified_at')::timestamptz,version=version+1 where id=c.id returning * into c;
 end if;
 if p_sighting is not null then
   insert into source_candidate_sightings(candidate_id,run_id,observation_key,provenance) values(c.id,(p_sighting->>'run_id')::uuid,p_sighting->>'observation_key',p_sighting->'provenance') on conflict do nothing;
 end if;
 return to_jsonb(c);
end $f$;

create or replace function public.source_publish_cycle(p_program uuid,p_state text,p_cycle_key text,p_opportunity jsonb,p_evidence jsonb) returns uuid
language plpgsql security invoker set search_path=public as $f$
declare p public.funding_programs;e public.source_engine_settings;s public.source_state_settings;c public.funding_cycles;oid uuid;old public.opportunities;
begin
 select * into e from source_engine_settings where id=true;
 select * into s from source_state_settings where state_code=p_state;
 if not e.engine_enabled or not s.publication_enabled or (p_state<>'FL' and e.florida_validated_at is null) then return null; end if;
 select * into p from funding_programs where id=p_program and review_status='APPROVED' and active and superseded_by is null for update;
 if not found or not(p_state=any(p.applicable_states)) then return null; end if;
 if p.current_cycle_open is not true or not(p.evidence ? 'current_cycle_open') or (p.current_deadline is not null and p.current_deadline<current_date) then
   -- Only explicit closed evidence or an evidenced expired deadline can close existing cycles.
   if (p.current_cycle_open is false and p.evidence ? 'current_cycle_open') or (p.current_deadline<current_date and p.evidence ? 'current_deadline') then
     update funding_cycles set status='CLOSED',last_seen_at=now() where program_id=p.id and status='OPEN';
     update opportunities set source_active=false,source_verified_at=now() where funding_program_id=p.id;
   end if;
   return null;
 end if;
 if p_cycle_key is null or length(p_cycle_key)>200 then raise exception 'A stable cycle identity is required'; end if;
 -- An expired, previously evidenced cycle stays in history when a new cycle opens.
 update funding_cycles set status='CLOSED',last_seen_at=now()
 where program_id=p.id and cycle_key<>p_cycle_key and status='OPEN' and deadline<current_date and evidence ? 'current_deadline';
 update opportunities o set source_active=false,source_verified_at=now()
 from funding_cycles old_cycle where o.source_cycle_id=old_cycle.id and old_cycle.program_id=p.id and old_cycle.status='CLOSED';
 insert into funding_cycles(program_id,cycle_key,status,deadline,evidence) values(p.id,p_cycle_key,'OPEN',p.current_deadline,p_evidence)
 on conflict(program_id,cycle_key) do update set status='OPEN',deadline=excluded.deadline,evidence=excluded.evidence,last_seen_at=now() returning * into c;
 oid=c.opportunity_id;
 -- Reconcile old Foundation Scan IDs only when explicitly attached during corpus import.
 if oid is null then select id into oid from opportunities where funding_program_id=p.id and source_cycle_id is null order by created_at limit 1 for update; end if;
 if oid is null then
   insert into opportunities(external_id,source,title,source_url,category,geography,summary,requirements,deadline,funding_amount,funding_amount_label,deadline_mentioned,amount_mentioned,deadline_verified,amount_verified,funding_program_id,source_cycle_id,source_active,source_verified_at)
   values('source-cycle-'||c.id,'Foundation Scan',p_opportunity->>'title',p_opportunity->>'source_url',p_opportunity->>'category',p.geography,p.summary,p.eligibility,p.current_deadline,p.award_max,p_opportunity->>'funding_amount_label',p_opportunity->>'deadline_mentioned',p_opportunity->>'amount_mentioned',(p_opportunity->>'deadline_verified')::boolean,(p_opportunity->>'amount_verified')::boolean,p.id,c.id,true,now()) returning id into oid;
 else
   select * into old from opportunities where id=oid for update;
   if old.title is distinct from p_opportunity->>'title' or old.summary is distinct from p.summary or old.deadline is distinct from p.current_deadline or old.requirements is distinct from p.eligibility or old.funding_amount is distinct from p.award_max or old.geography is distinct from p.geography then
     -- Scores remain historical; stamp invalidation instead of deleting customer records.
     update fit_scores set source_stale=true where opportunity_id=oid;
     update opportunities set ai_summary=null where id=oid;
   end if;
   update opportunities set title=p_opportunity->>'title',source_url=p_opportunity->>'source_url',category=p_opportunity->>'category',geography=p.geography,summary=p.summary,requirements=p.eligibility,deadline=p.current_deadline,funding_amount=p.award_max,funding_amount_label=p_opportunity->>'funding_amount_label',deadline_mentioned=p_opportunity->>'deadline_mentioned',amount_mentioned=p_opportunity->>'amount_mentioned',deadline_verified=(p_opportunity->>'deadline_verified')::boolean,amount_verified=(p_opportunity->>'amount_verified')::boolean,funding_program_id=p.id,source_cycle_id=c.id,source_active=true,source_verified_at=now() where id=oid;
 end if;
 update funding_cycles set opportunity_id=oid where id=c.id;
 return oid;
end $f$;
alter table public.fit_scores add column if not exists source_stale boolean not null default false;

create or replace function public.source_finish_job(p_job uuid,p_token uuid,p_status text,p_error text default null) returns void
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 if p_status not in('COMPLETED','FAILED','PAUSED','QUEUED') then raise exception 'Invalid completion status'; end if;
 select * into j from source_jobs where id=p_job and lease_token=p_token and status='RUNNING' for update;
 if not found then raise exception 'Job lease no longer owned'; end if;
 update source_jobs set status=p_status,last_error=p_error,finished_at=case when p_status in('COMPLETED','FAILED') then now() else null end,available_at=case when p_status='QUEUED' then now()+interval '2 hours' when p_status='PAUSED' then now() else available_at end,lease_until=null where id=p_job;
 if not exists(select 1 from source_jobs where run_id=j.run_id and status in('QUEUED','RUNNING')) then
   update source_discovery_runs set status=case when exists(select 1 from source_jobs where run_id=j.run_id and status='FAILED') then case when exists(select 1 from source_jobs where run_id=j.run_id and status='COMPLETED') then 'PARTIAL' else 'FAILED' end when exists(select 1 from source_jobs where run_id=j.run_id and status='PAUSED') then 'PAUSED' when coalesce((metrics->>'search_errors')::int,0)+coalesce((metrics->>'fetch_or_extraction_errors')::int,0)>0 then 'PARTIAL' else 'COMPLETED' end,finished_at=now(),errors=case when p_error is null then errors else errors||jsonb_build_array(p_error) end where id=j.run_id;
 end if;
end $f$;

do $block$
declare f record;
begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('source_ingest_candidate','source_publish_cycle','source_finish_job') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $block$;
commit;
