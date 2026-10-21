-- Contacts (clients, consultants, subcontractors, suppliers) belong to the company, not to a job, and the enquiry is the job record itself:
-- the enquiry becomes the tender, so its register fields live on `jobs`. Same tenancy rule as everywhere: child rows reference their parent on (id, org_id).

create table contacts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id),
  name        text not null check (length(trim(name)) > 0),
  kind        text not null check (kind in ('client', 'consultant', 'subcontractor', 'supplier', 'other')),
  person      text not null default '',
  phone       text not null default '',
  email       text not null default '',
  trade       text not null default '',
  notes       text not null default '',
  archived_at timestamptz,
  created_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, org_id)
);
-- one entry per company and kind (a company can be both a client and a subcontractor)
create unique index contacts_name_kind on contacts (org_id, lower(name), kind);

-- Ordinary fields: the latest edit wins and the earlier value is kept here.
create table contact_history (
  id          bigserial primary key,
  org_id      uuid not null,
  contact_id  uuid not null,
  at          timestamptz not null default now(),
  actor       uuid references users (id),
  changes     jsonb not null,
  foreign key (contact_id, org_id) references contacts (id, org_id) on delete cascade
);
create index contact_history_contact on contact_history (contact_id, id desc);

alter table jobs
  add column contact_id      uuid,
  add column due_at          timestamptz,
  add column owner_id        uuid,
  add column notes           text not null default '',
  add column approx_value    text not null default '' check (approx_value = '' or approx_value ~ '^[0-9]+(\.[0-9]{1,2})?$'),
  add column decision_reason text not null default '',
  add column decided_at      timestamptz,
  add column decided_by      uuid references users (id),
  add foreign key (contact_id, org_id) references contacts (id, org_id),
  add foreign key (org_id, owner_id) references memberships (org_id, user_id);
create index jobs_status on jobs (org_id, status);
