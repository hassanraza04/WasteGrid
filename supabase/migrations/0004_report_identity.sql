-- Additive dashboard identity. A public reference is never an access credential.
-- Backfills must finish deferred FK checks before subsequent ALTER TABLEs.
set constraints all immediate;
alter table wastegrid.reports
    add column public_reference varchar(15),
    add column title varchar(160) not null default 'Legacy report',
    add column address varchar(500);
create unique index reports_public_reference_key on wastegrid.reports(public_reference);

create function wastegrid.new_report_reference() returns text language plpgsql as $$
declare candidate text;
begin
    loop
        candidate := 'WG-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
        exit when not exists (select 1 from wastegrid.reports where public_reference = candidate);
    end loop;
    return candidate;
end $$;
alter table wastegrid.reports alter column public_reference
    set default wastegrid.new_report_reference();
update wastegrid.reports set public_reference = wastegrid.new_report_reference();
alter table wastegrid.reports alter column public_reference set not null;
alter table wastegrid.reports add constraint reports_reference_format
    check (public_reference ~ '^WG-[0-9A-F]{12}$');
alter table wastegrid.reports add constraint reports_title_nonblank check (length(btrim(title)) > 0);
alter table wastegrid.reports add constraint reports_address_nonblank check (address is null or length(btrim(address)) > 0);

create function wastegrid.preserve_report_reference() returns trigger language plpgsql as $$
begin
    if new.public_reference is distinct from old.public_reference then
        raise exception 'Report reference is immutable';
    end if;
    return new;
end $$;
create trigger preserve_report_reference before update on wastegrid.reports
    for each row execute function wastegrid.preserve_report_reference();
revoke all on function wastegrid.new_report_reference() from public, anon, authenticated;
revoke all on function wastegrid.preserve_report_reference() from public, anon, authenticated;
