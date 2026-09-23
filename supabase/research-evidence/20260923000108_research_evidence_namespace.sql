-- Research evidence knowledge namespace (staging). Isolated from public.* and gf_* tables.
create schema if not exists research_evidence;
revoke all on schema research_evidence from public, anon, authenticated;
comment on schema research_evidence is 'Portable research/evidence packages (not grant opportunities). Staging status per package; retrieve records with supports/does_not_support/prohibited_language/qa_flags together.';

create table research_evidence.packages (
  package_version text primary key,
  metadata jsonb not null,
  status text not null default 'staging' check (status in ('staging','active','retired')),
  loaded_at timestamptz not null default now(),
  activated_at timestamptz
);

create table research_evidence.claim_rules (
  package_version text not null references research_evidence.packages on delete cascade,
  rule_id text not null,
  code text not null,
  severity text not null,
  enforcement text,
  payload jsonb not null,
  primary key (package_version, rule_id)
);

create table research_evidence.evidence_records (
  package_version text not null references research_evidence.packages on delete cascade,
  record_id text not null check (record_id ~ '^CFSC-[0-9]{3}$'),
  topic text not null,
  evidence_level text not null check (evidence_level in ('A','B','C')),
  confidence text,
  evidence_domain text,
  geography text,
  geography_scope text[] not null,
  funding_tags text[] not null,
  qa_flags text[] not null,
  source_url text not null check (source_url ~ '^https?://'),
  verification_status text not null check (verification_status in ('PRIMARY_VERIFIED','PARTIALLY_VERIFIED','CONVERSATION_ONLY')),
  last_verified date,
  review_before_external_use boolean not null,
  payload jsonb not null,
  primary key (package_version, record_id),
  -- a null verification date must keep its review flag
  constraint unverified_requires_review check (last_verified is not null or review_before_external_use),
  constraint not_fully_verified_requires_review check (verification_status = 'PRIMARY_VERIFIED' or review_before_external_use)
);
create index on research_evidence.evidence_records using gin (funding_tags);
create index on research_evidence.evidence_records using gin (geography_scope);

create table research_evidence.record_aliases (
  package_version text not null references research_evidence.packages on delete cascade,
  legacy_record_id text not null,
  canonical_record_id text,
  resolution text not null,
  reason text,
  primary key (package_version, legacy_record_id),
  foreign key (package_version, canonical_record_id) references research_evidence.evidence_records (package_version, record_id)
);

create table research_evidence.statistics (
  package_version text not null references research_evidence.packages on delete cascade,
  stat_id text not null,
  record_id text not null,
  value numeric,
  unit text,
  verification_status text not null,
  review_before_external_use boolean not null,
  payload jsonb not null,
  primary key (package_version, stat_id),
  foreign key (package_version, record_id) references research_evidence.evidence_records (package_version, record_id)
);

create table research_evidence.funder_packets (
  package_version text not null references research_evidence.packages on delete cascade,
  packet_id text not null,
  name text not null,
  funding_tags text[] not null,
  payload jsonb not null,
  primary key (package_version, packet_id)
);

create table research_evidence.packet_evidence (
  package_version text not null,
  packet_id text not null,
  record_id text not null,
  role text not null check (role in ('priority','need','research','review_required')),
  primary key (package_version, packet_id, record_id, role),
  foreign key (package_version, packet_id) references research_evidence.funder_packets on delete cascade,
  foreign key (package_version, record_id) references research_evidence.evidence_records (package_version, record_id)
);

create table research_evidence.packet_statistics (
  package_version text not null,
  packet_id text not null,
  stat_id text not null,
  primary key (package_version, packet_id, stat_id),
  foreign key (package_version, packet_id) references research_evidence.funder_packets on delete cascade,
  foreign key (package_version, stat_id) references research_evidence.statistics
);

create table research_evidence.packet_rules (
  package_version text not null,
  packet_id text not null,
  rule_id text not null,
  primary key (package_version, packet_id, rule_id),
  foreign key (package_version, packet_id) references research_evidence.funder_packets on delete cascade,
  foreign key (package_version, rule_id) references research_evidence.claim_rules
);

create table research_evidence.source_review_queue (
  package_version text not null references research_evidence.packages on delete cascade,
  record_id text not null,
  payload jsonb not null,
  primary key (package_version, record_id),
  foreign key (package_version, record_id) references research_evidence.evidence_records (package_version, record_id)
);

create table research_evidence.source_library (
  package_version text not null references research_evidence.packages on delete cascade,
  source_url text not null,
  payload jsonb not null,
  primary key (package_version, source_url)
);

-- Background corpus (background_only retrieval policy). Loaded separately.
create table research_evidence.research_sections (
  package_version text not null references research_evidence.packages on delete cascade,
  section_id text not null,
  title text,
  content_markdown text not null,
  source_urls text[] not null default '{}',
  retrieval_policy text not null check (retrieval_policy like 'background_only%'),
  payload jsonb not null,
  primary key (package_version, section_id)
);

-- Alias-aware lookup: canonical IDs resolve to themselves, merged IDs resolve once, unresolved IDs return nothing.
create or replace function research_evidence.resolve_record(p_package text, p_id text)
returns setof research_evidence.evidence_records
language sql stable set search_path = '' as $$
  select e.* from research_evidence.evidence_records e
  where e.package_version = p_package
    and e.record_id = coalesce(
      (select a.canonical_record_id from research_evidence.record_aliases a
        where a.package_version = p_package and a.legacy_record_id = p_id
          and a.canonical_record_id is not null),
      case when exists (select 1 from research_evidence.record_aliases a
        where a.package_version = p_package and a.legacy_record_id = p_id) then null else p_id end);
$$;

-- Guarded retrieval view: evidence always travels with its limits and review status.
create or replace view research_evidence.guarded_evidence with (security_invoker = true) as
select e.package_version, e.record_id, e.topic, e.evidence_level, e.confidence, e.evidence_domain,
       e.geography, e.geography_scope, e.funding_tags, e.verification_status, e.last_verified,
       e.review_before_external_use, e.qa_flags,
       e.payload->>'finding' as finding,
       e.payload->>'population' as population,
       e.payload->>'year' as year,
       e.payload->'supports' as supports,
       e.payload->'does_not_support' as does_not_support,
       e.payload->'prohibited_language' as prohibited_language,
       e.payload->>'approved_language' as approved_language,
       e.source_url,
       case when e.verification_status = 'PRIMARY_VERIFIED' and not e.review_before_external_use
            then 'VERIFIED' else 'NEEDS_REVIEW' end as external_use_status
from research_evidence.evidence_records e
join research_evidence.packages p using (package_version);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'research_evidence' loop
    execute format('alter table research_evidence.%I enable row level security', t);
    execute format('revoke all on research_evidence.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on research_evidence.guarded_evidence from anon, authenticated;
revoke execute on function research_evidence.resolve_record(text, text) from public, anon, authenticated;
