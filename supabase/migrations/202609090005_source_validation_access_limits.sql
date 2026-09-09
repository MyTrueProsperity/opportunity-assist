begin;
-- A research sweep can be operationally sound while a third-party site refuses
-- access. Preserve PARTIAL and every error; an admin must explicitly accept those
-- limits. Internal/provider errors and unfinished work can never use this path.
create or replace function public.source_validate_florida(p_actor uuid,p_run uuid,p_validation jsonb) returns void
language plpgsql security invoker set search_path=public as $f$
declare r public.source_discovery_runs;
 access_error text := '^(HTTP (401|403|404|410|429|500|502|503|504)( |$)|Page timeout$|Robots unavailable or access restricted; deferred$|robots[.]txt disallows this path$|Redirect target robots disallows|Unreadable or bot-protected page; investigation required$|Unsupported document type:|PDF exceeds 40-page extraction limit$)';
begin
 perform public.source_require_actor(p_actor);
 select * into r from source_discovery_runs where id=p_run for update;
 if not found or r.state_code<>'FL' or not r.clean_room or r.status not in('COMPLETED','PARTIAL') then raise exception 'A completed independent Florida run is required'; end if;
 if r.status='PARTIAL' and not coalesce((p_validation->>'accepted_source_access_limits')::boolean,false) then raise exception 'A completed independent Florida run is required unless source-access limitations are explicitly reviewed'; end if;
 if exists(select 1 from source_jobs where run_id=p_run and status not in('COMPLETED','FAILED')) then raise exception 'Finish or resolve all queued, running and paused pilot jobs first'; end if;
 if coalesce((r.metrics->>'search_errors')::integer,0)>0
 or exists(select 1 from source_scan_history where run_id=p_run and error is not null and error !~ access_error)
 or exists(select 1 from source_jobs where run_id=p_run and status='FAILED' and (last_error is null or last_error !~ access_error))
 then raise exception 'Internal or provider failures require a fresh successful pilot; source-access review cannot override them'; end if;
 if r.status='PARTIAL' and not exists(select 1 from source_scan_history where run_id=p_run and error ~ access_error) then raise exception 'The partial result must have documented source-access limitations'; end if;
 if coalesce((r.metrics->>'search_requests')::integer,0)<1 or jsonb_array_length(r.queries)<1 or coalesce((r.metrics->>'candidates_extracted')::integer,0)<1 then raise exception 'Actual independent searches and extracted source evidence are required'; end if;
 if not exists(select 1 from source_engine_settings where seed_completed_at is not null) then raise exception 'Complete corpus ingestion first'; end if;
 if coalesce((p_validation->>'false_positive_checks')::integer,0)<1 or coalesce((p_validation->>'false_negative_checks')::integer,0)<1 or length(trim(coalesce(p_validation->>'notes','')))<40 then raise exception 'Record false-positive and false-negative spot checks and validation findings'; end if;
 if not coalesce((p_validation->>'passed')::boolean,false) then raise exception 'Validation has not passed'; end if;
 update source_discovery_runs set validation=p_validation,validated_by=p_actor,validated_at=now() where id=p_run;
 update source_engine_settings set florida_validation_run_id=p_run,florida_validated_at=now(),florida_validated_by=p_actor,updated_at=now() where id=true;
 insert into source_review_decisions(actor_id,action,notes,before_snapshot,after_snapshot) values(p_actor,'FLORIDA_VALIDATION',p_validation->>'notes',to_jsonb(r),p_validation);
end $f$;
revoke all on function public.source_validate_florida(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.source_validate_florida(uuid,uuid,jsonb) to service_role;
commit;
