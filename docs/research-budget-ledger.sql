-- OFFLINE REVIEW PROPOSAL. Not a migration; do not apply to production.
-- No credit cycle or approval is provisioned. A future migration/adapter needs
-- separate rollout review. This caps OA usage, not purchased-credit funding.
create schema research_budget;
revoke all on schema research_budget from public;
create table research_budget.mutex(id boolean primary key check(id));
insert into research_budget.mutex values(true);
create table research_budget.cycles(
  id text primary key check(length(id) between 1 and 200),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  prices_valid_until timestamptz not null,
  enabled boolean not null default false,
  fallback_risk_accepted boolean not null default false,
  promo_balance_micros bigint not null default 0 check(promo_balance_micros>=0),
  balance_verified_at timestamptz,
  shared_cushion_micros bigint not null default 15000000 check(shared_cushion_micros>=15000000),
  ceiling_micros bigint not null default 85000000 check(ceiling_micros between 0 and 85000000),
  trial_micros bigint not null default 10000000 check(trial_micros between 0 and 10000000),
  stage_micros bigint not null default 10000000 check(stage_micros between 0 and 85000000),
  expansion_review text,
  reserved_micros bigint not null default 0 check(reserved_micros>=0),
  actual_micros bigint not null default 0 check(actual_micros>=0),
  blocked_reason text,
  check(expires_at>starts_at),
  check(stage_micros<=ceiling_micros),
  check(stage_micros<=trial_micros or length(trim(expansion_review))>0 and expansion_review is not null)
);
create table research_budget.plans(
  cycle_id text not null references research_budget.cycles,
  plan_hash text not null check(plan_hash ~ '^[0-9a-f]{64}$'),
  review_reference text not null check(length(trim(review_reference))>0),
  primary key(cycle_id,plan_hash)
);
create table research_budget.attempts(
  id text primary key,
  cycle_id text not null references research_budget.cycles,
  plan_hash text not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  reserved_micros bigint not null check(reserved_micros>0),
  actual_micros bigint check(actual_micros>=0),
  status text not null default 'pending' check(status in('pending','settled','failed')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  proposal jsonb,
  final_usage jsonb,
  provider_request_id text,
  unique(cycle_id,request_hash),
  foreign key(cycle_id,plan_hash) references research_budget.plans
);
create index research_budget_unresolved on research_budget.attempts(status) where status<>'settled';
alter table research_budget.mutex enable row level security;
alter table research_budget.cycles enable row level security;
alter table research_budget.plans enable row level security;
alter table research_budget.attempts enable row level security;

create function research_budget.reserve(p_cycle text,p_plan text,p_attempt text,p_hash text,p_micros bigint,p_review text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,research_budget as $$
declare c research_budget.cycles; t timestamptz;
begin
  -- All admissions/settlements acquire this single short transaction lock.
  -- No network or provider call is performed while holding it.
  perform 1 from research_budget.mutex where id=true for update;
  if not found then raise exception 'RESEARCH_LEDGER_UNAVAILABLE'; end if;
  t:=clock_timestamp();
  select * into c from research_budget.cycles where id=p_cycle for update;
  if not found or not c.enabled or not c.fallback_risk_accepted or c.blocked_reason is not null then raise exception 'RESEARCH_DISABLED'; end if;
  if c.starts_at>t or least(c.expires_at,c.prices_valid_until)<=t+interval '390 seconds' then raise exception 'CREDIT_OR_PRICE_EXPIRED'; end if;
  if c.balance_verified_at is null or c.balance_verified_at>t or c.balance_verified_at<=t-interval '1 hour'+interval '390 seconds' then raise exception 'SHARED_BALANCE_STALE'; end if;
  if exists(select 1 from research_budget.cycles x where x.id<>c.id and x.starts_at<c.expires_at and x.expires_at>c.starts_at) then raise exception 'OVERLAPPING_CREDIT_CYCLE'; end if;
  if not exists(select 1 from research_budget.plans where cycle_id=p_cycle and plan_hash=p_plan and review_reference=p_review) then raise exception 'REVIEWED_DRY_RUN_REQUIRED'; end if;
  -- Deliberately one in-flight request organization-wide. A crash, timeout,
  -- ambiguous reservation acknowledgement or failed reconciliation blocks all
  -- later workers until reviewed recovery. No automatic lease expiry/refunds.
  if exists(select 1 from research_budget.attempts where status<>'settled') then raise exception 'RECONCILIATION_REQUIRED'; end if;
  if p_micros is null or p_micros<=0 or p_micros>10000000 then raise exception 'INVALID_RESERVATION'; end if;
  if p_attempt is null or p_attempt!~'^[-a-zA-Z0-9_]{1,100}$' then raise exception 'INVALID_ATTEMPT'; end if;
  if c.reserved_micros>least(c.ceiling_micros,c.stage_micros)-p_micros then raise exception 'RESEARCH_BUDGET_EXHAUSTED'; end if;
  -- Deduct all cycle reservations even if the observed balance already reflects
  -- earlier research. This double-counts conservatively; refresh never resets caps.
  if c.promo_balance_micros-c.shared_cushion_micros-c.reserved_micros<p_micros then raise exception 'SHARED_CREDIT_CUSHION'; end if;
  insert into research_budget.attempts(id,cycle_id,plan_hash,request_hash,reserved_micros)
    values(p_attempt,p_cycle,p_plan,p_hash,p_micros);
  update research_budget.cycles set reserved_micros=reserved_micros+p_micros where id=p_cycle;
  return jsonb_build_object('allowed',true,'attemptId',p_attempt,'requestHash',p_hash,'cycleId',p_cycle,'reserveMicros',p_micros,'fallbackRiskAccepted',true,
    'dispatchBefore',least(c.expires_at,c.prices_valid_until,c.balance_verified_at+interval '1 hour')-interval '390 seconds',
    'dispatchWindowMs',floor(extract(epoch from (least(c.expires_at,c.prices_valid_until,c.balance_verified_at+interval '1 hour')-interval '390 seconds'-t))*1000));
end $$;

create function research_budget.settle(p_cycle text,p_attempt text,p_actual bigint,p_proposal jsonb default null,p_usage jsonb default null,p_request_id text default null)
returns boolean language plpgsql security invoker set search_path=pg_catalog,research_budget as $$
declare a research_budget.attempts;
begin
  perform 1 from research_budget.mutex where id=true for update;
  if not found then raise exception 'RESEARCH_LEDGER_UNAVAILABLE'; end if;
  select * into a from research_budget.attempts where id=p_attempt and cycle_id=p_cycle for update;
  if not found then raise exception 'UNKNOWN_ATTEMPT'; end if;
  if a.status='settled' then
    if a.actual_micros=p_actual then return true; end if;
    raise exception 'SETTLEMENT_CONFLICT';
  end if;
  if a.status<>'pending' then raise exception 'RECONCILIATION_REQUIRED'; end if;
  if p_actual is null or p_actual<0 or p_actual>a.reserved_micros then
    update research_budget.attempts set status='failed' where id=p_attempt;
    update research_budget.cycles set blocked_reason='UNTRUSTED_FINAL_USAGE' where id=p_cycle;
    return false; -- persist the block; do not roll it back by raising
  end if;
  update research_budget.attempts set status='settled',actual_micros=p_actual,settled_at=clock_timestamp(),proposal=p_proposal,final_usage=p_usage,provider_request_id=p_request_id where id=p_attempt;
  update research_budget.cycles set actual_micros=actual_micros+p_actual where id=p_cycle;
  -- Keep the entire reservation against both caps, permanently. Actual usage
  -- is separately recorded for audit; lower usage never unlocks more spending.
  return true;
end $$;

create function research_budget.mark_failed(p_cycle text,p_attempt text)
returns boolean language plpgsql security invoker set search_path=pg_catalog,research_budget as $$
begin
  perform 1 from research_budget.mutex where id=true for update;
  if not found then raise exception 'RESEARCH_LEDGER_UNAVAILABLE'; end if;
  update research_budget.attempts set status='failed' where id=p_attempt and cycle_id=p_cycle and status='pending';
  update research_budget.cycles set blocked_reason='RECONCILIATION_REQUIRED' where id=p_cycle;
  return true;
end $$;
revoke all on all tables in schema research_budget from public,anon,authenticated;
revoke all on all functions in schema research_budget from public,anon,authenticated;
grant usage on schema research_budget to service_role;
grant select,insert,update on all tables in schema research_budget to service_role;
grant execute on all functions in schema research_budget to service_role;

-- PostgREST calls these through the existing public RPC surface and existing
-- service-role configuration. They retain invoker privileges; no new DB key or
-- exposed private schema is required. No anon/authenticated execution.
create function public.research_budget_reserve(p_cycle text,p_plan text,p_attempt text,p_hash text,p_micros bigint,p_review text)
returns jsonb language sql security invoker set search_path=pg_catalog as $$
  select research_budget.reserve(p_cycle,p_plan,p_attempt,p_hash,p_micros,p_review)
$$;
create function public.research_budget_settle(p_cycle text,p_attempt text,p_actual bigint,p_proposal jsonb default null,p_usage jsonb default null,p_request_id text default null)
returns boolean language sql security invoker set search_path=pg_catalog as $$
  select research_budget.settle(p_cycle,p_attempt,p_actual,p_proposal,p_usage,p_request_id)
$$;
create function public.research_budget_mark_failed(p_cycle text,p_attempt text)
returns boolean language sql security invoker set search_path=pg_catalog as $$
  select research_budget.mark_failed(p_cycle,p_attempt)
$$;
revoke all on function public.research_budget_reserve(text,text,text,text,bigint,text),public.research_budget_settle(text,text,bigint,jsonb,jsonb,text),public.research_budget_mark_failed(text,text) from public,anon,authenticated;
grant execute on function public.research_budget_reserve(text,text,text,text,bigint,text),public.research_budget_settle(text,text,bigint,jsonb,jsonb,text),public.research_budget_mark_failed(text,text) to service_role;
