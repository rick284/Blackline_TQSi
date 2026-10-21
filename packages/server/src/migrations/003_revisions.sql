-- Issued tender revisions. A revision is the whole job exactly as it stood when it was sent to the client: every checked-in record, the headline
-- figures, who issued it and any blockers they overrode. Once written it is never edited or deleted; the only thing that can ever change on a row is
-- that a later revision supersedes it. The database enforces that, not just the application.
create table tender_revisions (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null,
  job_id         uuid not null,
  seq            integer not null check (seq >= 1),
  label          text not null,
  note           text not null default '',
  issued_by      uuid not null references users (id),
  issued_at      timestamptz not null default now(),
  snapshot       jsonb not null,
  snapshot_hash  text not null,
  totals         jsonb not null,
  overrides      jsonb not null default '[]',
  superseded_by  uuid,
  superseded_at  timestamptz,
  unique (id, org_id),
  unique (job_id, seq),
  foreign key (job_id, org_id) references jobs (id, org_id),
  foreign key (superseded_by, org_id) references tender_revisions (id, org_id)
);
create index tender_revisions_job on tender_revisions (job_id, seq);

create function tender_revisions_frozen() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'An issued tender revision cannot be deleted.';
  end if;
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.job_id is distinct from old.job_id or new.seq is distinct from old.seq
     or new.label is distinct from old.label or new.note is distinct from old.note or new.issued_by is distinct from old.issued_by
     or new.issued_at is distinct from old.issued_at or new.snapshot is distinct from old.snapshot or new.snapshot_hash is distinct from old.snapshot_hash
     or new.totals is distinct from old.totals or new.overrides is distinct from old.overrides then
    raise exception 'An issued tender revision cannot be edited. Issue a new revision to supersede it.';
  end if;
  if old.superseded_by is not null and (new.superseded_by is distinct from old.superseded_by or new.superseded_at is distinct from old.superseded_at) then
    raise exception 'This revision has already been superseded.';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger tender_revisions_frozen before update or delete on tender_revisions
  for each row execute function tender_revisions_frozen();
