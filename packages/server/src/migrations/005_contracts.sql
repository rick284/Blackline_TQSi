-- Awarding a job. The contract refers to the issued revision it was awarded from (which stays frozen), records the contract sum and terms, and
-- holds the control budget: the cost the estimate carried, copied line by line at the moment of award. The budget lines are never edited or deleted;
-- later changes (variations) will be new lines against the contract, so the original budget is always there to measure against.

create table contracts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  job_id        uuid not null,
  revision_id   uuid not null,
  awarded_on    text not null check (awarded_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  contract_sum  text not null check (contract_sum ~ '^[0-9]+\.[0-9]{2}$'),
  tender_all_in text not null check (tender_all_in ~ '^-?[0-9]+\.[0-9]{2}$'),
  terms         jsonb not null default '{}',
  awarded_by    uuid not null references users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (id, org_id),
  unique (job_id),
  foreign key (job_id, org_id) references jobs (id, org_id),
  foreign key (revision_id, org_id) references tender_revisions (id, org_id)
);

create table contract_budget_lines (
  contract_id  uuid not null,
  org_id       uuid not null,
  seq          integer not null check (seq >= 1),
  code         text not null,
  description  text not null,
  section      text not null,
  kind         text not null check (kind in ('qs', 'allowance', 'subcontract')),
  source       text not null,
  amount       text not null check (amount ~ '^-?[0-9]+\.[0-9]{2}$'),
  primary key (contract_id, code),
  foreign key (contract_id, org_id) references contracts (id, org_id)
);

create function contract_budget_frozen() returns trigger as $$
begin
  raise exception 'The control budget cannot be edited or deleted. Record changes as variations.';
end;
$$ language plpgsql;

create trigger contract_budget_frozen before update or delete on contract_budget_lines
  for each row execute function contract_budget_frozen();
