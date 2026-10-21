-- What a variation's warnings run on: when it went to the client, when they should reply by, and whether the work has started without approval.
alter table cost_variations
  add column submitted_on text check (submitted_on is null or submitted_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  add column response_due text check (response_due is null or response_due ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  add column at_risk boolean not null default false;
