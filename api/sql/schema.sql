-- Dressmaker dress-preview schema (Postgres / Neon).
-- Idempotent: safe to run more than once. `npm run db:init` applies this file.
--
-- Player screenshots are NEVER stored. The quota tables store only an HMAC hash
-- of the client IP, and no table or log ever holds the raw address.

-- ---------------------------------------------------------------------------
-- generations: one row per generation attempt that reached the AI provider.
-- ---------------------------------------------------------------------------
create table if not exists generations (
  id              uuid primary key default gen_random_uuid(),
  client_id       varchar(64),
  client_ip_hash  varchar(64),
  npc_id          varchar(64) not null,
  source          varchar(64),
  campaign        varchar(64),
  status          varchar(16) not null check (status in ('success', 'failed')),
  provider        varchar(32),
  model           varchar(64),
  latency_ms      integer,
  estimated_cost  numeric(10, 4),
  error_type      varchar(32),
  counted         boolean not null default false,
  created_at      timestamptz not null default now()
);

-- Migrate older installs that keyed a non-null anonymous_id on this table.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'generations' and column_name = 'anonymous_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'generations' and column_name = 'client_id'
  ) then
    alter table generations rename column anonymous_id to client_id;
    alter table generations alter column client_id drop not null;
  end if;
end $$;

alter table generations add column if not exists client_ip_hash varchar(64);
alter table generations add column if not exists counted boolean not null default false;

create index if not exists generations_created_at_idx on generations (created_at desc);
create index if not exists generations_client_idx on generations (client_id, created_at desc);

-- ---------------------------------------------------------------------------
-- feedback: optional yes / kind-of / no rating plus free text.
-- ---------------------------------------------------------------------------
create table if not exists feedback (
  id             uuid primary key default gen_random_uuid(),
  generation_id  uuid not null references generations (id) on delete cascade,
  rating         varchar(16) not null check (rating in ('yes', 'kind_of', 'no')),
  feedback_text  varchar(500),
  source         varchar(64),
  created_at     timestamptz not null default now(),
  unique (generation_id)
);

create index if not exists feedback_created_at_idx on feedback (created_at desc);

-- ---------------------------------------------------------------------------
-- usage_daily / global_usage_daily: the authoritative cost counters.
--
-- These are keyed by the HMAC hash of the trusted client IP, NOT by anything the
-- browser sends. Earlier versions keyed usage_daily by a browser-generated id,
-- which a visitor could reset by clearing storage. That old table is renamed
-- aside (never dropped) so its metadata survives the migration; browser ids are
-- deliberately NOT copied into ip_hash, which would be meaningless and unsafe.
-- ---------------------------------------------------------------------------
do $$
declare
  candidate text;
  suffix integer := 0;
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'usage_daily' and column_name = 'anonymous_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_name = 'usage_daily' and column_name = 'ip_hash'
  ) then
    candidate := 'usage_daily_legacy_' || to_char(now(), 'YYYYMMDDHH24MISS');
    while to_regclass(candidate) is not null loop
      suffix := suffix + 1;
      candidate := 'usage_daily_legacy_' || to_char(now(), 'YYYYMMDDHH24MISS') || '_' || suffix;
    end loop;
    execute format('alter table usage_daily rename to %I', candidate);
    raise notice 'Renamed legacy usage_daily (browser-id keyed) to %.', candidate;
  end if;
end $$;

create table if not exists usage_daily (
  usage_date  date not null,
  ip_hash     varchar(64) not null,
  count       integer not null default 0,
  primary key (usage_date, ip_hash)
);

create table if not exists global_usage_daily (
  usage_date  date primary key,
  count       integer not null default 0
);

-- ---------------------------------------------------------------------------
-- reserve_generation_quota: reserve BOTH counters atomically, before the paid
-- provider call. Returns allowed=false (and charges nothing) when a ceiling is
-- reached, when the day is disabled, or when the identity is unusable.
--
-- A per-day advisory lock serializes reservations across every function
-- instance, so concurrent requests can never overshoot either ceiling.
-- ---------------------------------------------------------------------------
create or replace function reserve_generation_quota(
  p_ip_hash      text,
  p_user_limit   integer,
  p_global_limit integer,
  p_usage_date   date
)
returns table (allowed boolean, reason text, user_count integer, global_count integer)
language plpgsql
as $$
declare
  v_user_count   integer := 0;
  v_global_count integer := 0;
begin
  if p_ip_hash is null or length(p_ip_hash) < 16 then
    return query select false, 'invalid_identity', 0, 0;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('dressmaker-quota'), hashtext(p_usage_date::text));

  if p_user_limit is null or p_global_limit is null or p_user_limit <= 0 or p_global_limit <= 0 then
    return query select false, 'disabled', 0, 0;
    return;
  end if;

  select u.count into v_user_count
  from usage_daily u
  where u.usage_date = p_usage_date and u.ip_hash = p_ip_hash;
  v_user_count := coalesce(v_user_count, 0);

  select g.count into v_global_count
  from global_usage_daily g
  where g.usage_date = p_usage_date;
  v_global_count := coalesce(v_global_count, 0);

  if v_user_count >= p_user_limit then
    return query select false, 'user_limit', v_user_count, v_global_count;
    return;
  end if;

  if v_global_count >= p_global_limit then
    return query select false, 'global_limit', v_user_count, v_global_count;
    return;
  end if;

  insert into usage_daily (usage_date, ip_hash, count)
  values (p_usage_date, p_ip_hash, 1)
  on conflict (usage_date, ip_hash) do update set count = usage_daily.count + 1
  returning count into v_user_count;

  insert into global_usage_daily (usage_date, count)
  values (p_usage_date, 1)
  on conflict (usage_date) do update set count = global_usage_daily.count + 1
  returning count into v_global_count;

  return query select true, 'ok', v_user_count, v_global_count;
end;
$$;
