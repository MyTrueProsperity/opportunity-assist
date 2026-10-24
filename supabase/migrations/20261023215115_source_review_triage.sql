-- Source Intelligence: spend the daily page budget on fresh sources, and
-- review the most promising candidates first.
--
-- 1. Re-verification. Every pending candidate was re-fetched every 7 days,
--    including ones already checked whose remaining question needs a person
--    (ambiguous eligibility or geography, no state named, thin evidence).
--    Re-reading those pages does not answer the question, and about 1,900 of
--    the ~5,000 queued checks were such repeats while new imports waited.
--    They are now re-checked every 30 days; everything else keeps 7 days.
--
-- 2. review_priority. A stored score so the review queue can show the
--    candidates most likely to become real leads first: a funding mechanism,
--    a named program, a stated deadline, Florida or national eligibility,
--    a stated award, and a completed page check raise it; a confirmed dead
--    end lowers it.
--
-- No data is deleted.

create or replace function public.source_due_verifications(p_state text,p_limit integer default 2) returns setof public.source_candidates
language sql security invoker set search_path=public as $f$
 select c.* from source_candidates c join source_state_settings s on s.state_code=c.state_code cross join source_engine_settings e
 where e.id and e.engine_enabled and e.automatic_approval_enabled
 and (s.discovery_enabled or s.monitoring_enabled) and (s.state_code='FL' or e.florida_validated_at is not null)
 and c.state_code=p_state and c.status in('PENDING','INVESTIGATING','MATCHED') and not(c.proposed ? 'resolved_candidate_ids')
 and c.next_verification_at<=now()
 and coalesce(c.last_verified_at,c.first_seen_at) < now() - case
       when c.last_verified_at is not null and c.reason_code in ('HUMAN_REVIEW','GEOGRAPHY_UNSUPPORTED','INSUFFICIENT_EVIDENCE') then interval '30 days'
       else interval '7 days' end
 and not exists(select 1 from source_review_decisions d where d.candidate_id=c.id and d.decision_origin='MANUAL')
 and not exists(select 1 from source_jobs j where j.state_code=c.state_code and j.status in('QUEUED','RUNNING','PAUSED') and (j.payload->>'candidate_id'=c.id::text or j.payload->>'url'=c.source_url))
 order by c.next_verification_at,c.first_seen_at,c.id limit greatest(0,least(p_limit,10));
$f$;

alter table public.source_candidates add column if not exists review_priority integer generated always as (
    (case when coalesce(proposed->>'funding_mechanism','')<>'' then 4 else 0 end)
  + (case when coalesce(proposed->>'program_name','')<>'' then 1 else 0 end)
  + (case when coalesce(proposed->>'current_deadline','')<>'' then 3 else 0 end)
  + (case when coalesce(proposed->'applicable_states','[]'::jsonb) ? 'FL' then 3
          when coalesce(proposed->>'geography','') ~* '(florida|national|nationwide|united states|all states)' then 2 else 0 end)
  + (case when coalesce(proposed->>'award_max', proposed->>'award_min', '')<>'' then 1 else 0 end)
  + (case when last_verified_at is not null then 1 else 0 end)
  - (case when reason_code in ('NO_FUNDING_MECHANISM','INDIVIDUAL_SCHOLARSHIP','LOAN_OUT_OF_SCOPE','DIRECTORY','AGGREGATOR','NEWS_ONLY','EXPIRED_ONE_OFF') and last_verified_at is not null then 6 else 0 end)
) stored;
create index if not exists source_candidates_review_priority_idx
  on public.source_candidates (review_priority desc, first_seen_at desc, id desc) where status in ('PENDING','INVESTIGATING');
