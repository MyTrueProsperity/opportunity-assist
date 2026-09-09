begin;
create or replace function public.source_finish_job(p_job uuid,p_token uuid,p_status text,p_error text default null) returns void
language plpgsql security invoker set search_path=public as $f$
declare j public.source_jobs;
begin
 if p_status not in('COMPLETED','FAILED','PAUSED','QUEUED') then raise exception 'Invalid job result'; end if;
 select * into j from source_jobs where id=p_job and lease_token=p_token and status='RUNNING' for update;
 if not found then raise exception 'Job lease lost'; end if;
 update source_jobs set status=p_status,last_error=p_error,finished_at=case when p_status in('COMPLETED','FAILED') then now() else null end,available_at=case when p_status='QUEUED' then now()+interval '2 hours' when p_status='PAUSED' then now() else available_at end,lease_until=null where id=p_job;
 -- Record every failure immediately, including when other jobs are still running.
 if p_error is not null then update source_discovery_runs set errors=errors||jsonb_build_array(jsonb_build_object('job_id',j.id,'source_url',j.payload->>'url','error',p_error)) where id=j.run_id; end if;
 if not exists(select 1 from source_jobs where run_id=j.run_id and status in('QUEUED','RUNNING')) then
  update source_discovery_runs set status=case when exists(select 1 from source_jobs where run_id=j.run_id and status='FAILED') then case when exists(select 1 from source_jobs where run_id=j.run_id and status='COMPLETED') then 'PARTIAL' else 'FAILED' end when exists(select 1 from source_jobs where run_id=j.run_id and status='PAUSED') then 'PAUSED' when coalesce((metrics->>'search_errors')::int,0)+coalesce((metrics->>'fetch_or_extraction_errors')::int,0)>0 then 'PARTIAL' else 'COMPLETED' end,finished_at=now() where id=j.run_id;
 end if;
end $f$;
revoke all on function public.source_finish_job(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.source_finish_job(uuid,uuid,text,text) to service_role;
-- Surface existing scan errors without erasing older messages or duplicating a backfill.
update source_discovery_runs r set errors=r.errors||(
 select jsonb_agg(jsonb_build_object('scan_id',h.id,'source_url',h.source_url,'error',h.error)) from source_scan_history h
 where h.run_id=r.id and h.error is not null and not exists(select 1 from jsonb_array_elements(r.errors) item where item->>'scan_id'=h.id::text)
) where exists(select 1 from source_scan_history h where h.run_id=r.id and h.error is not null and not exists(select 1 from jsonb_array_elements(r.errors) item where item->>'scan_id'=h.id::text));
commit;
