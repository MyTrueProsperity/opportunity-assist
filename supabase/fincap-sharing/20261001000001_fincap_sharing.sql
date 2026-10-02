-- Pass & Share with FinCap: editorial review pipeline for passed grants.
--
-- A grant an organization passes on can still be useful to other financial
-- capability practitioners. This adds an OPT-IN, REVIEWED path to
-- NationalFinCap.org. Nothing here publishes automatically.
--
-- Boundaries (all enforced in the database, not in a prompt or the browser):
--   * Base tables are private: RLS on, no policies, no grants to anon or
--     authenticated. Members reach them only through the SECURITY DEFINER
--     functions below, which check org membership via auth.uid().
--   * Reviewer actions require a row in public.admins (the existing
--     administrator role). Source verification is NOT approval: nothing here
--     reads source_active/source_verified_at to publish anything.
--   * Public output is built from `published`, a snapshot of allowlisted
--     fields written only when an admin approves. Org ids, passing reasons,
--     notes, activity, fit scores, ai_summary (it is generated with
--     organization-profile context) and Grant Factory data are never columns
--     of that snapshot.
--   * fincap_public_list / fincap_newsletter_export are executable only by
--     service_role, so the only public path is the cached Netlify function.
-- Safe to re-run.

create table if not exists public.fincap_submissions (
  id uuid primary key default gen_random_uuid(),
  public_id uuid not null default gen_random_uuid() unique,   -- the only id ever shown publicly
  identity_key text not null,                                  -- stable opportunity identity
  cycle_key text not null,                                     -- funding cycle; a new annual cycle is a new submission
  opportunity_id uuid references public.opportunities(id) on delete set null,
  status text not null default 'pending_review'
    check (status in ('pending_review', 'approved', 'rejected', 'withdrawn')),
  needs_review boolean not null default false,                 -- approved claim whose source changed
  needs_review_reason text,
  version integer not null default 1,                          -- optimistic lock for edits and decisions
  published_version integer not null default 0,                -- bumped on every (re)approval
  source_fingerprint jsonb,                                    -- source facts at submit/approve, for change detection
  -- Editorial draft: the allowlist of public fields.
  pub_title text,
  pub_funder text,
  pub_source_url text,
  pub_amount_text text,
  pub_amount_verified boolean not null default false,
  pub_deadline date,
  pub_deadline_tz text not null default 'America/New_York',
  pub_deadline_kind text not null default 'unknown' check (pub_deadline_kind in ('fixed', 'rolling', 'unknown')),
  pub_deadline_verified boolean not null default false,
  pub_eligible_applicants text,
  pub_geography text,
  pub_program_areas text[] not null default '{}',
  pub_summary text,
  pub_verified_on date,
  has_unpublished_edits boolean not null default false,
  -- Approved snapshot: the only thing public functions read.
  published jsonb,
  published_at timestamptz,
  material_updated_at timestamptz,
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  decision_reason text,
  withdrawn_at timestamptz,
  first_shared_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint fincap_submissions_identity_cycle unique (identity_key, cycle_key)
);
create index if not exists fincap_submissions_status_idx on public.fincap_submissions (status, updated_at desc);
create index if not exists fincap_submissions_opportunity_idx on public.fincap_submissions (opportunity_id);

-- Which organization(s) passed on it. Private attribution; never public.
create table if not exists public.fincap_submission_shares (
  submission_id uuid not null references public.fincap_submissions(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete set null,
  shared_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (submission_id, org_id)
);
create index if not exists fincap_shares_org_idx on public.fincap_submission_shares (org_id, created_at desc);

-- Append-only editorial audit trail.
create table if not exists public.fincap_review_events (
  id bigint generated always as identity primary key,
  submission_id uuid not null references public.fincap_submissions(id) on delete cascade,
  actor_id uuid,
  action text not null,
  reason text,
  created_at timestamptz not null default now()
);
create index if not exists fincap_events_submission_idx on public.fincap_review_events (submission_id, created_at);

-- Newsletter history. Recording an issue is a deliberate admin action; an
-- export never writes here, so an unsent draft cannot look like it was sent.
create table if not exists public.fincap_issues (
  issue_date date primary key,
  recorded_by uuid references public.profiles(id),
  recorded_at timestamptz not null default now(),
  sent_at timestamptz,                -- set only when an admin says the email actually went out
  note text
);
create table if not exists public.fincap_issue_items (
  issue_date date not null references public.fincap_issues(issue_date) on delete cascade,
  submission_id uuid not null references public.fincap_submissions(id) on delete cascade,
  published_version integer not null,
  include_reason text,
  primary key (issue_date, submission_id)
);

alter table public.fincap_submissions enable row level security;
alter table public.fincap_submission_shares enable row level security;
alter table public.fincap_review_events enable row level security;
alter table public.fincap_issues enable row level security;
alter table public.fincap_issue_items enable row level security;
revoke all on public.fincap_submissions, public.fincap_submission_shares, public.fincap_review_events,
  public.fincap_issues, public.fincap_issue_items from public, anon, authenticated;

-- ---------------------------------------------------------------- helpers

create or replace function public.fincap_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where profile_id = (select auth.uid()));
$$;

-- Stable identity: the registry program when there is one, else the source
-- URL, else the opportunity row.
create or replace function public.fincap_identity_key(o public.opportunities) returns text
language sql immutable set search_path = public as $$
  select case
    when o.funding_program_id is not null then 'program:' || o.funding_program_id::text
    when nullif(btrim(o.source_url), '') is not null
      then 'url:' || lower(regexp_replace(regexp_replace(btrim(o.source_url), '^https?://(www\.)?', ''), '[?#].*$|/+$', '', 'g'))
    else 'opp:' || o.id::text
  end;
$$;

-- Funding cycle: the registry's cycle key, else the deadline year, else
-- "undated" (rolling or unknown), so a new annual cycle gets its own review.
create or replace function public.fincap_cycle_key(o public.opportunities) returns text
language sql stable set search_path = public as $$
  select coalesce(
    (select c.cycle_key from public.funding_cycles c where c.id = o.source_cycle_id),
    case when o.deadline is not null then 'deadline-' || to_char(o.deadline, 'YYYY') end,
    'undated');
$$;

create or replace function public.fincap_source_fingerprint(o public.opportunities) returns jsonb
language sql immutable as $$
  select jsonb_build_object('title', o.title, 'source_url', o.source_url, 'deadline', o.deadline,
    'amount', o.funding_amount_label, 'amount_value', o.funding_amount, 'geography', o.geography,
    'source_active', o.source_active);
$$;

-- The allowlist. Add a field here and nowhere else to make it public.
create or replace function public.fincap_build_published(s public.fincap_submissions) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'title', s.pub_title,
    'funder', s.pub_funder,
    'source_url', s.pub_source_url,
    'amount_text', case when s.pub_amount_verified then s.pub_amount_text end,
    'deadline', case when s.pub_deadline_kind = 'fixed' then s.pub_deadline end,
    'deadline_tz', s.pub_deadline_tz,
    'deadline_kind', s.pub_deadline_kind,
    'deadline_verified', s.pub_deadline_verified,
    'eligible_applicants', s.pub_eligible_applicants,
    'geography', s.pub_geography,
    'program_areas', to_jsonb(s.pub_program_areas),
    'summary', s.pub_summary,
    'last_verified_on', s.pub_verified_on);
$$;

-- Returns an error message when the draft is not publishable, else null.
create or replace function public.fincap_publish_problem(s public.fincap_submissions) returns text
language plpgsql stable set search_path = public as $$
declare v_org text; v_tz text;
begin
  if coalesce(btrim(s.pub_title), '') = '' then return 'A title is required.'; end if;
  if coalesce(btrim(s.pub_funder), '') = '' then return 'The funder is required.'; end if;
  if s.pub_source_url is null or s.pub_source_url !~* '^https?://[^ ]+$' then return 'An official source link (http or https) is required.'; end if;
  if char_length(coalesce(btrim(s.pub_summary), '')) < 40 then return 'Write an original summary of at least 40 characters.'; end if;
  if char_length(s.pub_summary) > 700 then return 'Keep the summary under 700 characters.'; end if;
  if coalesce(btrim(s.pub_eligible_applicants), '') = '' and coalesce(btrim(s.pub_geography), '') = '' then
    return 'State who can apply or where the opportunity is available, so readers can judge fit.';
  end if;
  if s.pub_verified_on is null then return 'A last-verified date is required.'; end if;
  if s.pub_deadline_kind = 'fixed' and s.pub_deadline is null then return 'A fixed deadline needs a date.'; end if;
  if s.pub_amount_verified and coalesce(btrim(s.pub_amount_text), '') = '' then return 'Verified amount is marked but empty.'; end if;
  begin perform now() at time zone s.pub_deadline_tz; exception when others then return 'Unknown deadline timezone.'; end;
  v_tz := s.pub_deadline_tz;
  if s.pub_deadline_kind = 'fixed' and s.pub_deadline < (now() at time zone v_tz)::date then
    return 'This deadline has already passed.';
  end if;
  -- Organization-neutral guard: the summary must not name any organization
  -- that passed on this grant, nor use second or first person framing.
  for v_org in
    select o.name from public.fincap_submission_shares sh join public.organizations o on o.id = sh.org_id
    where sh.submission_id = s.id
  loop
    if char_length(btrim(v_org)) >= 3 and (
         position(lower(btrim(v_org)) in lower(coalesce(s.pub_summary, '') || ' ' || coalesce(s.pub_eligible_applicants, '') || ' ' || coalesce(s.pub_title, ''))) > 0) then
      return 'The public text mentions an organization that passed on this grant. Make it organization-neutral.';
    end if;
  end loop;
  if s.pub_summary ~* '\m(your|our|we|my)\M\s+(organi[sz]ation|nonprofit|agency|mission|programs?|fit)\M'
     or s.pub_summary ~* '\m(fit score|not a fit|we passed|passed on|private note)\M' then
    return 'The summary reads as organization-specific. Rewrite it neutrally.';
  end if;
  return null;
end;
$$;

-- --------------------------------------------------------- member actions

-- One transaction: the private Pass decision, the (optional) pipeline card
-- removal that Capture Pipeline review does, the review submission, the
-- attribution and the activity entry. Retries and double clicks are safe.
create or replace function public.fincap_pass_and_share(
  p_org uuid, p_opportunity uuid,
  p_system_recommendation text default null, p_system_confidence integer default null,
  p_pipeline_item uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := (select auth.uid());
  o public.opportunities;
  v_ident text; v_cycle text;
  v_decision uuid; v_sub public.fincap_submissions;
  v_created boolean := false; v_new_decision boolean := false; v_new_share boolean := false;
  v_rows integer; v_funder text; v_areas text[]; v_applicants text;
begin
  if v_user is null then raise exception 'Sign in required' using errcode = '42501'; end if;
  if p_org is null or p_opportunity is null then raise exception 'Organization and opportunity are required'; end if;
  if not exists (select 1 from public.org_memberships m where m.org_id = p_org and m.user_id = v_user) then
    raise exception 'Not authorized for this organization' using errcode = '42501';
  end if;
  select * into o from public.opportunities where id = p_opportunity;
  if not found then raise exception 'Opportunity not found'; end if;

  v_ident := public.fincap_identity_key(o);
  v_cycle := public.fincap_cycle_key(o);
  perform pg_advisory_xact_lock(hashtextextended(v_ident || '|' || v_cycle, 0));

  -- 1. Private decision for this organization (idempotent while it stands).
  select d.id into v_decision from (
    select id, decision from public.pursue_decisions
    where org_id = p_org and opportunity_id = p_opportunity order by decided_at desc, id desc limit 1) d
  where d.decision = 'pass';
  if v_decision is null then
    insert into public.pursue_decisions (org_id, opportunity_id, pipeline_item_id, system_recommendation, system_confidence, decision, decided_by)
    values (p_org, p_opportunity,
            (select id from public.pipeline_items where id = p_pipeline_item and org_id = p_org),
            p_system_recommendation, p_system_confidence, 'pass', v_user)
    returning id into v_decision;
    v_new_decision := true;
  end if;

  -- 2. Capture Pipeline card: same effect as the review-page Pass, atomically.
  if p_pipeline_item is not null and exists (
       select 1 from public.pipeline_items where id = p_pipeline_item and org_id = p_org and opportunity_id = p_opportunity) then
    update public.opportunity_activity set pipeline_item_id = null where pipeline_item_id = p_pipeline_item;
    delete from public.pipeline_items where id = p_pipeline_item;
  end if;

  -- 3. One submission per (identity, cycle).
  select * into v_sub from public.fincap_submissions where identity_key = v_ident and cycle_key = v_cycle;
  if not found then
    select oo.canonical_name into v_funder
      from public.funding_programs fp join public.funding_organizations oo on oo.id = fp.organization_id
      where fp.id = o.funding_program_id;
    select coalesce(fp.funding_categories, case when o.category is not null then array[o.category] end, '{}'),
           nullif(array_to_string(fp.applicant_types, ', '), '')
      into v_areas, v_applicants
      from (select 1) x left join public.funding_programs fp on fp.id = o.funding_program_id;
    insert into public.fincap_submissions (
      identity_key, cycle_key, opportunity_id, source_fingerprint, first_shared_by,
      pub_title, pub_funder, pub_source_url, pub_amount_text, pub_amount_verified,
      pub_deadline, pub_deadline_kind, pub_deadline_verified,
      pub_eligible_applicants, pub_geography, pub_program_areas, pub_verified_on)
    values (
      v_ident, v_cycle, o.id, public.fincap_source_fingerprint(o), v_user,
      o.title, coalesce(v_funder, o.source), o.source_url,
      case when coalesce(o.amount_verified, false) then o.funding_amount_label end, coalesce(o.amount_verified, false),
      o.deadline, case when o.deadline is not null then 'fixed' else 'unknown' end, coalesce(o.deadline_verified, false),
      v_applicants, o.geography, coalesce(v_areas, '{}'), o.source_verified_at::date)
    -- pub_summary stays empty on purpose: ai_summary and summary are never copied.
    returning * into v_sub;
    v_created := true;
    insert into public.fincap_review_events (submission_id, actor_id, action) values (v_sub.id, v_user, 'submitted');
  end if;

  insert into public.fincap_submission_shares (submission_id, org_id, opportunity_id, shared_by)
  values (v_sub.id, p_org, p_opportunity, v_user) on conflict do nothing;
  get diagnostics v_rows = row_count;
  v_new_share := v_rows > 0;

  if v_new_decision or v_new_share then
    insert into public.opportunity_activity (org_id, opportunity_id, actor_id, action, detail)
    values (p_org, p_opportunity, v_user, 'pursue_decision',
            'Passed and offered to FinCap for editorial review (' || v_sub.status || ')');
  end if;

  return jsonb_build_object(
    'decision_id', v_decision,
    'submission_status', v_sub.status,
    'needs_review', v_sub.needs_review,
    'created', v_created,
    'already_submitted', not v_created);
end;
$$;

-- Share state for one organization's passed grants (bounded, minimal columns).
create or replace function public.fincap_my_shares(p_org uuid)
returns table (opportunity_id uuid, status text, needs_review boolean, shared_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if (select auth.uid()) is null
     or not exists (select 1 from public.org_memberships m where m.org_id = p_org and m.user_id = (select auth.uid())) then
    raise exception 'Not authorized for this organization' using errcode = '42501';
  end if;
  return query
    select sh.opportunity_id, s.status, s.needs_review, sh.created_at
    from public.fincap_submission_shares sh join public.fincap_submissions s on s.id = sh.submission_id
    where sh.org_id = p_org and sh.opportunity_id is not null
    order by sh.created_at desc limit 500;
end;
$$;

-- --------------------------------------------------------- admin actions

create or replace function public.fincap_admin_list(p_status text default 'pending_review', p_limit integer default 50, p_before timestamptz default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.fincap_is_admin() then raise exception 'Administrator required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(r order by (r->>'updated_at') desc) from (
      select jsonb_build_object(
        'id', s.id, 'public_id', s.public_id, 'status', s.status, 'needs_review', s.needs_review,
        'needs_review_reason', s.needs_review_reason, 'version', s.version, 'published_version', s.published_version,
        'has_unpublished_edits', s.has_unpublished_edits, 'cycle_key', s.cycle_key,
        'draft', jsonb_build_object('title', s.pub_title, 'funder', s.pub_funder, 'source_url', s.pub_source_url,
          'amount_text', s.pub_amount_text, 'amount_verified', s.pub_amount_verified, 'deadline', s.pub_deadline,
          'deadline_tz', s.pub_deadline_tz, 'deadline_kind', s.pub_deadline_kind, 'deadline_verified', s.pub_deadline_verified,
          'eligible_applicants', s.pub_eligible_applicants, 'geography', s.pub_geography,
          'program_areas', to_jsonb(s.pub_program_areas), 'summary', s.pub_summary, 'last_verified_on', s.pub_verified_on),
        'published', s.published, 'published_at', s.published_at, 'decision_reason', s.decision_reason,
        'problem', public.fincap_publish_problem(s),
        'shared_by_orgs', (select coalesce(jsonb_agg(o.name), '[]'::jsonb) from public.fincap_submission_shares sh
                           join public.organizations o on o.id = sh.org_id where sh.submission_id = s.id),
        'created_at', s.created_at, 'updated_at', s.updated_at) as r
      from public.fincap_submissions s
      where (p_status is null or p_status = 'all' or s.status = p_status
             or (p_status = 'needs_review' and s.needs_review))
        and (p_before is null or s.updated_at < p_before)
      order by s.updated_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 100)) q), '[]'::jsonb);
end;
$$;

create or replace function public.fincap_admin_edit(p_id uuid, p_fields jsonb, p_version integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.fincap_submissions; f jsonb := coalesce(p_fields, '{}'::jsonb); k text;
  allowed text[] := array['title','funder','source_url','amount_text','amount_verified','deadline','deadline_tz',
    'deadline_kind','deadline_verified','eligible_applicants','geography','program_areas','summary','last_verified_on'];
begin
  if not public.fincap_is_admin() then raise exception 'Administrator required' using errcode = '42501'; end if;
  for k in select jsonb_object_keys(f) loop
    if not (k = any (allowed)) then raise exception 'Field % cannot be edited', k; end if;
  end loop;
  select * into s from public.fincap_submissions where id = p_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if s.version <> p_version then raise exception 'This submission changed. Reload and try again.'; end if;
  if s.status = 'withdrawn' or s.status = 'rejected' then raise exception 'Reopen this submission before editing it.'; end if;
  if f ? 'deadline_kind' and (f->>'deadline_kind') not in ('fixed','rolling','unknown') then raise exception 'Invalid deadline kind'; end if;
  update public.fincap_submissions set
    pub_title = case when f ? 'title' then left(nullif(btrim(f->>'title'), ''), 300) else pub_title end,
    pub_funder = case when f ? 'funder' then left(nullif(btrim(f->>'funder'), ''), 300) else pub_funder end,
    pub_source_url = case when f ? 'source_url' then left(nullif(btrim(f->>'source_url'), ''), 1000) else pub_source_url end,
    pub_amount_text = case when f ? 'amount_text' then left(nullif(btrim(f->>'amount_text'), ''), 200) else pub_amount_text end,
    pub_amount_verified = case when f ? 'amount_verified' then (f->>'amount_verified')::boolean else pub_amount_verified end,
    pub_deadline = case when f ? 'deadline' then nullif(f->>'deadline', '')::date else pub_deadline end,
    pub_deadline_tz = case when f ? 'deadline_tz' then coalesce(nullif(btrim(f->>'deadline_tz'), ''), 'America/New_York') else pub_deadline_tz end,
    pub_deadline_kind = case when f ? 'deadline_kind' then f->>'deadline_kind' else pub_deadline_kind end,
    pub_deadline_verified = case when f ? 'deadline_verified' then (f->>'deadline_verified')::boolean else pub_deadline_verified end,
    pub_eligible_applicants = case when f ? 'eligible_applicants' then left(nullif(btrim(f->>'eligible_applicants'), ''), 800) else pub_eligible_applicants end,
    pub_geography = case when f ? 'geography' then left(nullif(btrim(f->>'geography'), ''), 300) else pub_geography end,
    pub_program_areas = case when f ? 'program_areas' then coalesce(array(select left(btrim(x), 80) from jsonb_array_elements_text(f->'program_areas') x where btrim(x) <> '' limit 8), '{}') else pub_program_areas end,
    pub_summary = case when f ? 'summary' then left(nullif(btrim(f->>'summary'), ''), 1500) else pub_summary end,
    pub_verified_on = case when f ? 'last_verified_on' then nullif(f->>'last_verified_on', '')::date else pub_verified_on end,
    has_unpublished_edits = (status = 'approved'),
    version = version + 1, updated_at = now()
  where id = p_id returning * into s;
  insert into public.fincap_review_events (submission_id, actor_id, action) values (p_id, (select auth.uid()), 'edited');
  return jsonb_build_object('version', s.version, 'status', s.status, 'problem', public.fincap_publish_problem(s));
end;
$$;

create or replace function public.fincap_admin_decide(p_id uuid, p_action text, p_reason text, p_version integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s public.fincap_submissions; o public.opportunities; v_actor uuid := (select auth.uid()); v_problem text;
begin
  if not public.fincap_is_admin() then raise exception 'Administrator required' using errcode = '42501'; end if;
  select * into s from public.fincap_submissions where id = p_id for update;
  if not found then raise exception 'Submission not found'; end if;
  if s.version <> p_version then raise exception 'This submission changed. Reload and try again.'; end if;

  if p_action = 'approve' then
    if s.status not in ('pending_review', 'approved') then raise exception 'Only pending or approved submissions can be approved.'; end if;
    v_problem := public.fincap_publish_problem(s);
    if v_problem is not null then raise exception 'Cannot publish: %', v_problem; end if;
    select * into o from public.opportunities where id = s.opportunity_id;
    update public.fincap_submissions set
      status = 'approved', published = public.fincap_build_published(s),
      published_version = published_version + 1,
      published_at = coalesce(published_at, now()),
      material_updated_at = now(),
      needs_review = false, needs_review_reason = null, has_unpublished_edits = false,
      source_fingerprint = case when o.id is not null then public.fincap_source_fingerprint(o) else source_fingerprint end,
      decided_by = v_actor, decided_at = now(), decision_reason = nullif(btrim(p_reason), ''),
      withdrawn_at = null, version = version + 1, updated_at = now()
    where id = p_id returning * into s;
  elsif p_action = 'reject' then
    if s.status <> 'pending_review' then raise exception 'Only pending submissions can be rejected. Withdraw a published one instead.'; end if;
    if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
    update public.fincap_submissions set status = 'rejected', decided_by = v_actor, decided_at = now(),
      decision_reason = btrim(p_reason), version = version + 1, updated_at = now() where id = p_id returning * into s;
  elsif p_action = 'withdraw' then
    if s.status <> 'approved' then raise exception 'Only published submissions can be withdrawn.'; end if;
    if coalesce(btrim(p_reason), '') = '' then raise exception 'A reason is required.'; end if;
    update public.fincap_submissions set status = 'withdrawn', withdrawn_at = now(), decided_by = v_actor,
      decided_at = now(), decision_reason = btrim(p_reason), needs_review = false,
      version = version + 1, updated_at = now() where id = p_id returning * into s;
  elsif p_action = 'reopen' then
    if s.status not in ('rejected', 'withdrawn') then raise exception 'Only rejected or withdrawn submissions can be reopened.'; end if;
    update public.fincap_submissions set status = 'pending_review', decision_reason = null,
      version = version + 1, updated_at = now() where id = p_id returning * into s;
  else
    raise exception 'Unknown action %', p_action;
  end if;
  insert into public.fincap_review_events (submission_id, actor_id, action, reason)
  values (p_id, v_actor, p_action, nullif(btrim(p_reason), ''));
  return jsonb_build_object('status', s.status, 'version', s.version, 'published_version', s.published_version);
end;
$$;

-- Record the issue that was actually finalized. Separate from export on
-- purpose; sent_at stays null unless the admin says the email went out.
create or replace function public.fincap_record_issue(p_issue_date date, p_public_ids uuid[], p_note text default null, p_sent_at timestamptz default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_missing integer; v_n integer;
begin
  if not public.fincap_is_admin() then raise exception 'Administrator required' using errcode = '42501'; end if;
  if p_issue_date is null then raise exception 'Issue date required'; end if;
  if coalesce(array_length(p_public_ids, 1), 0) > 100 then raise exception 'Too many items'; end if;
  select count(*) into v_missing from unnest(coalesce(p_public_ids, '{}')) u(pid)
    where not exists (select 1 from public.fincap_submissions s where s.public_id = u.pid and s.status = 'approved');
  if v_missing > 0 then raise exception '% item(s) are not currently published', v_missing; end if;
  insert into public.fincap_issues (issue_date, recorded_by, sent_at, note)
  values (p_issue_date, (select auth.uid()), p_sent_at, nullif(btrim(p_note), ''))
  on conflict (issue_date) do update set recorded_by = excluded.recorded_by, recorded_at = now(),
    sent_at = coalesce(excluded.sent_at, public.fincap_issues.sent_at), note = coalesce(excluded.note, public.fincap_issues.note);
  delete from public.fincap_issue_items where issue_date = p_issue_date;
  insert into public.fincap_issue_items (issue_date, submission_id, published_version)
  select p_issue_date, s.id, s.published_version from public.fincap_submissions s where s.public_id = any (coalesce(p_public_ids, '{}'));
  get diagnostics v_n = row_count;
  return jsonb_build_object('issue_date', p_issue_date, 'items_recorded', v_n, 'sent', p_sent_at is not null);
end;
$$;

-- ---------------------------------------------------- source-change guard

-- A material source change never edits the approved public claim. It only
-- flags the publication so an editor re-verifies and re-approves.
create or replace function public.fincap_flag_source_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.title, old.source_url, old.deadline, old.funding_amount_label, old.funding_amount, old.geography, old.source_active)
     is not distinct from
     (new.title, new.source_url, new.deadline, new.funding_amount_label, new.funding_amount, new.geography, new.source_active) then
    return new;
  end if;
  update public.fincap_submissions
     set needs_review = true, needs_review_reason = 'The source changed after approval. Re-verify before the next issue.',
         updated_at = now()
   where opportunity_id = new.id and status = 'approved' and not needs_review;
  return new;
end;
$$;
drop trigger if exists fincap_source_change on public.opportunities;
create trigger fincap_source_change
  after update of title, source_url, deadline, funding_amount_label, funding_amount, geography, source_active
  on public.opportunities for each row execute function public.fincap_flag_source_change();

-- ------------------------------------------------------- public projection

-- The only public read path (service_role only; the Netlify function calls
-- it). Reads the approved snapshot, never the draft or any private column.
create or replace function public.fincap_public_list(p_as_of timestamptz default now(), p_limit integer default 200)
returns table (
  id uuid, title text, funder text, source_url text, amount_text text,
  deadline date, deadline_tz text, deadline_kind text, deadline_verified boolean,
  eligible_applicants text, geography text, program_areas jsonb, summary text,
  last_verified_on date, status text, recheck_pending boolean, published_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.public_id, s.published->>'title', s.published->>'funder', s.published->>'source_url', s.published->>'amount_text',
    (s.published->>'deadline')::date, s.published->>'deadline_tz', s.published->>'deadline_kind',
    coalesce((s.published->>'deadline_verified')::boolean, false),
    s.published->>'eligible_applicants', s.published->>'geography', s.published->'program_areas', s.published->>'summary',
    (s.published->>'last_verified_on')::date,
    case when s.published->>'deadline_kind' = 'rolling' then 'rolling'
         when s.published->>'deadline_kind' <> 'fixed' then 'date_unconfirmed'
         when (s.published->>'deadline')::date <= (p_as_of at time zone (s.published->>'deadline_tz'))::date + 14 then 'closing_soon'
         else 'open' end,
    s.needs_review, s.published_at, s.material_updated_at
  from public.fincap_submissions s
  where s.status = 'approved' and s.published is not null
    and (s.published->>'deadline_kind' <> 'fixed'
         or (s.published->>'deadline')::date >= (p_as_of at time zone (s.published->>'deadline_tz'))::date)
  order by (s.published->>'deadline')::date asc nulls last, s.published->>'title'
  limit least(greatest(coalesce(p_limit, 200), 1), 300);
$$;

-- Newsletter-ready set for an issue date. Reads only; writes nothing.
-- Included: approved, not awaiting re-verification, still open on the issue
-- date, and either never recorded in an earlier issue, materially updated
-- since, or (when asked) a deadline reminder. Cutoff is noon America/New_York
-- on the issue date unless p_as_of is given.
create or replace function public.fincap_newsletter_export(p_issue_date date, p_repeat_deadline_days integer default null, p_as_of timestamptz default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_as_of timestamptz := coalesce(p_as_of, (p_issue_date::timestamp + interval '12 hours') at time zone 'America/New_York');
begin
  if p_issue_date is null then raise exception 'Issue date required'; end if;
  return (
    with base as (
      select s.*,
        (select max(i.published_version) from public.fincap_issue_items i where i.submission_id = s.id and i.issue_date <> p_issue_date) as last_version,
        ((s.published->>'deadline')::date - (v_as_of at time zone (s.published->>'deadline_tz'))::date) as days_left
      from public.fincap_submissions s
      where s.status = 'approved' and s.published is not null and s.published_at <= v_as_of
        and (s.published->>'deadline_kind' <> 'fixed'
             or (s.published->>'deadline')::date >= (v_as_of at time zone (s.published->>'deadline_tz'))::date)
    ), picked as (
      select b.*, case
          when b.last_version is null then 'new'
          when b.published_version > b.last_version then 'updated'
          when p_repeat_deadline_days is not null and b.published->>'deadline_kind' = 'fixed' and b.days_left <= p_repeat_deadline_days then 'deadline_reminder'
        end as include_reason
      from base b
    )
    select jsonb_build_object(
      'issue_date', p_issue_date,
      'as_of', v_as_of,
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'id', p.public_id, 'include_reason', p.include_reason,
          'title', p.published->>'title', 'funder', p.published->>'funder', 'source_url', p.published->>'source_url',
          'amount_text', p.published->>'amount_text', 'deadline', p.published->>'deadline', 'deadline_tz', p.published->>'deadline_tz',
          'deadline_kind', p.published->>'deadline_kind', 'deadline_verified', coalesce((p.published->>'deadline_verified')::boolean, false),
          'deadline_flag', case when p.published->>'deadline_kind' = 'rolling' then 'Rolling: no fixed deadline. Check the funder.'
                                when p.published->>'deadline_kind' <> 'fixed' then 'Deadline not confirmed. Do not state a date.'
                                when not coalesce((p.published->>'deadline_verified')::boolean, false) then 'Deadline not verified against the funder. Confirm before sending.' end,
          'eligible_applicants', p.published->>'eligible_applicants', 'geography', p.published->>'geography',
          'program_areas', p.published->'program_areas', 'summary', p.published->>'summary',
          'last_verified_on', p.published->>'last_verified_on')
          order by (p.published->>'deadline')::date asc nulls last, p.published->>'title')
        from picked p where p.include_reason is not null and not p.needs_review), '[]'::jsonb),
      'held_for_recheck', coalesce((select jsonb_agg(jsonb_build_object('id', p.public_id, 'title', p.published->>'title', 'reason', p.needs_review_reason))
        from picked p where p.include_reason is not null and p.needs_review), '[]'::jsonb),
      'previously_included_count', (select count(*) from picked p where p.include_reason is null)
    )
  );
end;
$$;

revoke all on function public.fincap_is_admin(), public.fincap_pass_and_share(uuid, uuid, text, integer, uuid),
  public.fincap_my_shares(uuid), public.fincap_admin_list(text, integer, timestamptz),
  public.fincap_admin_edit(uuid, jsonb, integer), public.fincap_admin_decide(uuid, text, text, integer),
  public.fincap_record_issue(date, uuid[], text, timestamptz), public.fincap_public_list(timestamptz, integer),
  public.fincap_newsletter_export(date, integer, timestamptz), public.fincap_publish_problem(public.fincap_submissions),
  public.fincap_flag_source_change() from public, anon, authenticated;
grant execute on function public.fincap_is_admin(), public.fincap_pass_and_share(uuid, uuid, text, integer, uuid),
  public.fincap_my_shares(uuid), public.fincap_admin_list(text, integer, timestamptz),
  public.fincap_admin_edit(uuid, jsonb, integer), public.fincap_admin_decide(uuid, text, text, integer),
  public.fincap_record_issue(date, uuid[], text, timestamptz) to authenticated;
grant execute on function public.fincap_public_list(timestamptz, integer), public.fincap_newsletter_export(date, integer, timestamptz) to service_role;
