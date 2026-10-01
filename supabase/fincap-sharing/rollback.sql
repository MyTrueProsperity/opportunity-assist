-- Rollback for 20261001000001_fincap_sharing.sql. Additive feature: nothing
-- else depends on these objects. Run only after taking the cost-free backup
-- below if any real submissions exist:
--   create table public._fincap_backup as select * from public.fincap_submissions;
drop trigger if exists fincap_source_change on public.opportunities;
drop function if exists public.fincap_flag_source_change();
drop function if exists public.fincap_newsletter_export(date, integer, timestamptz);
drop function if exists public.fincap_public_list(timestamptz, integer);
drop function if exists public.fincap_record_issue(date, uuid[], text, timestamptz);
drop function if exists public.fincap_admin_decide(uuid, text, text, integer);
drop function if exists public.fincap_admin_edit(uuid, jsonb, integer);
drop function if exists public.fincap_admin_list(text, integer, timestamptz);
drop function if exists public.fincap_my_shares(uuid);
drop function if exists public.fincap_pass_and_share(uuid, uuid, text, integer, uuid);
drop function if exists public.fincap_publish_problem(public.fincap_submissions);
drop function if exists public.fincap_build_published(public.fincap_submissions);
drop function if exists public.fincap_source_fingerprint(public.opportunities);
drop function if exists public.fincap_cycle_key(public.opportunities);
drop function if exists public.fincap_identity_key(public.opportunities);
drop function if exists public.fincap_is_admin();
drop table if exists public.fincap_issue_items, public.fincap_issues, public.fincap_review_events,
  public.fincap_submission_shares, public.fincap_submissions;
-- Private pass decisions and activity rows made through Pass & Share are
-- ordinary pursue_decisions / opportunity_activity rows and are kept.
