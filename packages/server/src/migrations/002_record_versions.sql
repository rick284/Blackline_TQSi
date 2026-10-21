-- What each record was at each version of its package. A row is written for every record a check-in changes (data is null when it
-- deleted the record), and for every record when a job is first loaded. With it the server can say what a person's refused check-in
-- was based on, so the compare screen shows only what they actually changed, not their whole old copy of the record.
create table record_versions (
  package_id  uuid not null,
  org_id      uuid not null,
  record_id   text not null,
  version     integer not null,
  data        jsonb,
  primary key (package_id, record_id, version),
  foreign key (package_id, org_id) references packages (id, org_id) on delete cascade
);

-- Packages that already exist: record their records as they stand now, at the package's current version.
insert into record_versions (package_id, org_id, record_id, version, data)
select r.package_id, r.org_id, r.record_id, p.version, r.data
  from package_records r join packages p on p.id = r.package_id and p.org_id = r.org_id;
