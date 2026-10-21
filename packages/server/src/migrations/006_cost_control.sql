-- Cost control for an awarded job: the ledgers that are measured against the control budget. Money is dollars-and-cents text, never a float.
-- Commitments and actual costs are insert-only: a mistake is voided (kept, with who and why, counting for nothing), never edited or deleted.
-- A variation is open to change only while it is pending; a decision freezes it. A forecast is a new entry each time, and the latest wins, so the
-- earlier ones are kept.

create table cost_commitments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  job_id      uuid not null,
  code        text not null,
  supplier    text not null,
  ref         text not null default '',
  description text not null default '',
  amount      text not null check (amount ~ '^[0-9]+\.[0-9]{2}$'),
  date        text not null check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  created_by  uuid not null references users (id),
  created_at  timestamptz not null default now(),
  voided_at   timestamptz,
  voided_by   uuid references users (id),
  void_reason text,
  unique (id, org_id),
  foreign key (job_id, org_id) references jobs (id, org_id)
);
create index cost_commitments_job on cost_commitments (job_id);

create table cost_actuals (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  job_id        uuid not null,
  code          text not null,
  kind          text not null check (kind in ('invoice', 'labour', 'plant', 'materials', 'other')),
  supplier      text not null default '',
  ref           text not null default '',
  description   text not null default '',
  amount        text not null check (amount ~ '^-?[0-9]+\.[0-9]{2}$'),
  hours         text not null default '' check (hours = '' or hours ~ '^[0-9]+(\.[0-9]{1,2})?$'),
  date          text not null check (date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  commitment_id uuid,
  created_by    uuid not null references users (id),
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid references users (id),
  void_reason   text,
  unique (id, org_id),
  foreign key (job_id, org_id) references jobs (id, org_id),
  foreign key (commitment_id, org_id) references cost_commitments (id, org_id)
);
create index cost_actuals_job on cost_actuals (job_id);

create table cost_variations (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  job_id        uuid not null,
  ref           text not null,
  title         text not null,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  sell          text not null check (sell ~ '^-?[0-9]+\.[0-9]{2}$'),
  lines         jsonb not null default '[]',
  note          text not null default '',
  created_by    uuid not null references users (id),
  created_at    timestamptz not null default now(),
  decided_by    uuid references users (id),
  decided_at    timestamptz,
  decision_note text not null default '',
  unique (id, org_id),
  unique (job_id, ref),
  foreign key (job_id, org_id) references jobs (id, org_id)
);

create table cost_forecasts (
  id         bigserial primary key,
  org_id     uuid not null,
  job_id     uuid not null,
  code       text not null,
  etc        text check (etc is null or etc ~ '^[0-9]+\.[0-9]{2}$'),
  note       text not null default '',
  created_by uuid not null references users (id),
  created_at timestamptz not null default now(),
  foreign key (job_id, org_id) references jobs (id, org_id)
);
create index cost_forecasts_job on cost_forecasts (job_id, code, id desc);

create table payment_claims (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  job_id        uuid not null,
  seq           integer not null check (seq >= 1),
  period_end    text not null check (period_end ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  value_ex      text not null check (value_ex ~ '^[0-9]+\.[0-9]{2}$'),
  retention_pct text not null default '0',
  status        text not null default 'draft' check (status in ('draft', 'submitted', 'paid')),
  submitted_on  text,
  paid_on       text,
  paid_amount   text not null default '0.00' check (paid_amount ~ '^[0-9]+\.[0-9]{2}$'),
  note          text not null default '',
  created_by    uuid not null references users (id),
  created_at    timestamptz not null default now(),
  voided_at     timestamptz,
  voided_by     uuid references users (id),
  void_reason   text,
  unique (id, org_id),
  unique (job_id, seq),
  foreign key (job_id, org_id) references jobs (id, org_id)
);

-- ledgers: nothing is deleted, and an entry changes only by being voided, once
create function cost_ledger_frozen() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Cost entries cannot be deleted. Void the entry instead.';
  end if;
  if old.voided_at is not null then
    raise exception 'A voided entry cannot be changed.';
  end if;
  if (to_jsonb(new) - 'voided_at' - 'voided_by' - 'void_reason') is distinct from (to_jsonb(old) - 'voided_at' - 'voided_by' - 'void_reason') then
    raise exception 'A cost entry cannot be edited. Void it and enter it again.';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger cost_commitments_frozen before update or delete on cost_commitments for each row execute function cost_ledger_frozen();
create trigger cost_actuals_frozen before update or delete on cost_actuals for each row execute function cost_ledger_frozen();

create function cost_no_delete() returns trigger as $$
begin
  raise exception 'This record cannot be deleted.';
end;
$$ language plpgsql;
create trigger payment_claims_keep before delete on payment_claims for each row execute function cost_no_delete();
create trigger cost_variations_keep before delete on cost_variations for each row execute function cost_no_delete();

create function cost_forecasts_frozen() returns trigger as $$
begin
  raise exception 'A forecast is kept as entered. Enter a new one.';
end;
$$ language plpgsql;
create trigger cost_forecasts_frozen before update or delete on cost_forecasts for each row execute function cost_forecasts_frozen();

create function cost_variation_decided() returns trigger as $$
begin
  if old.status <> 'pending' then
    raise exception 'A decided variation cannot be changed.';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger cost_variation_decided before update on cost_variations for each row execute function cost_variation_decided();
