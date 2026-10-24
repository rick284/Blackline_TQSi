-- The company's own resource library: rates kept across jobs. A job still prices from its own Rate Library package (a copy taken when the rate is
-- used), so changing a company rate later never silently reprices a tender that has already been worked on.
create table company_rates (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references organisations (id),
  code              text not null check (length(trim(code)) > 0),
  category          text not null default '',
  description       text not null default '',
  unit              text not null default '',
  base_rate         text not null default '0' check (base_rate ~ '^[0-9]+(\.[0-9]{1,6})?$'),
  operator_included text not null default '' check (operator_included in ('', 'Yes', 'No')),
  fuel_included     text not null default '' check (fuel_included in ('', 'Yes', 'No')),
  source            text not null default '',
  created_by        uuid not null references users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (id, org_id)
);
create unique index company_rates_code on company_rates (org_id, lower(code));

-- A job that has been issued or awarded can never be deleted (its revisions are frozen), so the register can archive it out of the way instead.
alter table jobs add column archived_at timestamptz;
