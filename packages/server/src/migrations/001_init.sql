-- Blackline schema. Every tenant table carries org_id, and child tables reference their parent on (id, org_id), so a row can never
-- point at another company's data. Money and quantities live inside jsonb as decimal strings, never floats.

create table organisations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(trim(name)) > 0),
  created_at  timestamptz not null default now()
);

create table users (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  name           text not null check (length(trim(name)) > 0),
  password_hash  text not null,
  created_at     timestamptz not null default now()
);
create unique index users_email_key on users (lower(email));

create table memberships (
  org_id      uuid not null references organisations (id),
  user_id     uuid not null references users (id),
  role        text not null check (role in ('owner', 'manager', 'estimator', 'viewer')),
  created_at  timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user on memberships (user_id);

create table sessions (
  token_hash  text primary key,
  user_id     uuid not null references users (id),
  org_id      uuid not null references organisations (id),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  foreign key (org_id, user_id) references memberships (org_id, user_id)
);

create table jobs (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id),
  name        text not null check (length(trim(name)) > 0),
  client      text not null default '',
  status      text not null default 'enquiry' check (status in ('enquiry', 'tender', 'issued', 'awarded', 'lost', 'no-bid')),
  created_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (org_id, name)
);

-- A package is the unit of checkout. `version` rises by one on every accepted check-in.
create table packages (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id),
  job_id      uuid not null,
  key         text not null,
  name        text not null,
  kind        text not null,
  version     integer not null default 1 check (version >= 1),
  created_at  timestamptz not null default now(),
  unique (id, org_id),
  unique (job_id, key),
  foreign key (job_id, org_id) references jobs (id, org_id) on delete cascade
);
create index packages_job on packages (job_id);

create table package_records (
  package_id  uuid not null,
  org_id      uuid not null,
  record_id   text not null,
  data        jsonb not null,
  primary key (package_id, record_id),
  foreign key (package_id, org_id) references packages (id, org_id) on delete cascade
);

-- At most one lock per package: the primary key is the rule.
create table locks (
  package_id    uuid primary key,
  org_id        uuid not null,
  holder        uuid not null references users (id),
  base_version  integer not null,
  taken_at      timestamptz not null default now(),
  foreign key (package_id, org_id) references packages (id, org_id) on delete cascade
);

-- A check-in that was refused is kept here for a person to compare and choose; it is never applied.
create table parked_changes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  package_id    uuid not null,
  holder        uuid not null references users (id),
  base_version  integer not null,
  changes       jsonb not null,
  reason        text not null,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references users (id),
  foreign key (package_id, org_id) references packages (id, org_id) on delete cascade
);
create index parked_open on parked_changes (org_id, package_id) where resolved_at is null;

-- Add-only records (quotes received, RFIs, timesheets, site diary entries) never conflict and need no lock. First write wins.
create table append_records (
  org_id      uuid not null,
  job_id      uuid not null,
  record_id   text not null,
  data        jsonb not null,
  created_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  primary key (job_id, record_id),
  foreign key (job_id, org_id) references jobs (id, org_id) on delete cascade
);

create table audit_events (
  id          bigserial primary key,
  org_id      uuid not null references organisations (id),
  at          timestamptz not null default now(),
  actor       uuid references users (id),
  action      text not null,
  job_id      uuid,
  package_id  uuid,
  detail      jsonb not null default '{}'::jsonb
);
create index audit_org_time on audit_events (org_id, at desc);
