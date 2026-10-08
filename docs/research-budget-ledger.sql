-- OFFLINE REVIEW PROPOSAL. Not a migration; do not apply to production.
-- No credit cycle or approval is provisioned. A future migration/adapter needs
-- separate review after promotional-only funding is actually enforceable.
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
  unique(cycle_id,request_hash),
  foreign key(cycle_id,plan_hash) references research_budget.plans
);
create index research_budget_unresolved on research_budget.attempts(status) where status<>'settled';
alter table research_budget.mutex enable row level security;
alter table research_budget.cycles enable row level security;
alter table research_budget.plans enable row level security;
alter table research_budget.attempts enable row level security;

create function research_budget.reserve(p_cycle text,p_plan text,p_attempt text,p_hash text,p_micros bigint)
returns boolean language plpgsql security invoker set search_path=pg_catalog,research_budget as $$
declare c research_budget.cycles; t timestamptz;
begin
  -- All admissions/settlements acquire this single short transaction lock.
  -- No network or provider call is performed while holding it.
  perform 1 from research_budget.mutex where id=true for update;
  if not found then raise exception 'RESEARCH_LEDGER_UNAVAILABLE'; end if;
  t:=clock_timestamp();
  select * into c from research_budget.cycles where id=p_cycle for update;
  if not found or not c.enabled or c.blocked_reason is not null then raise exception 'RESEARCH_DISABLED'; end if;
  if c.starts_at>t or least(c.expires_at,c.prices_valid_until)<=t+interval '390 seconds' then raise exception 'CREDIT_OR_PRICE_EXPIRED'; end if;
  if exists(select 1 from research_budget.cycles x where x.id<>c.id and x.enabled and x.starts_at<c.expires_at and x.expires_at>c.starts_at) then raise exception 'OVERLAPPING_CREDIT_CYCLE'; end if;
  if not exists(select 1 from research_budget.plans where cycle_id=p_cycle and plan_hash=p_plan) then raise exception 'REVIEWED_DRY_RUN_REQUIRED'; end if;
  -- Deliberately one in-flight request organization-wide. A crash, timeout,
  -- ambiguous reservation acknowledgement or failed reconciliation blocks all
  -- later workers until reviewed recovery. No automatic lease expiry/refunds.
  if exists(select 1 from research_budget.attempts where status<>'settled') then raise exception 'RECONCILIATION_REQUIRED'; end if;
  if p_micros is null or p_micros<=0 or p_micros>10000000 then raise exception 'INVALID_RESERVATION'; end if;
  if p_attempt is null or p_attempt!~'^[-a-zA-Z0-9_]{1,100}$' then raise exception 'INVALID_ATTEMPT'; end if;
  if c.reserved_micros>least(c.ceiling_micros,c.stage_micros)-p_micros then raise exception 'RESEARCH_BUDGET_EXHAUSTED'; end if;
  insert into research_budget.attempts(id,cycle_id,plan_hash,request_hash,reserved_micros)
    values(p_attempt,p_cycle,p_plan,p_hash,p_micros);
  update research_budget.cycles set reserved_micros=reserved_micros+p_micros where id=p_cycle;
  return true;
end $$;

create function research_budget.settle(p_cycle text,p_attempt text,p_actual bigint)
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
  update research_budget.attempts set status='settled',actual_micros=p_actual,settled_at=clock_timestamp() where id=p_attempt;
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
