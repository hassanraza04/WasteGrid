-- Durable approval and cost boundaries for the supervised organiser demo.
create table wastegrid.assessment_demo_runs (
    id uuid primary key,
    scope_key varchar(80) not null unique check (scope_key = 'organizer-demo-v1'),
    status varchar(20) not null check (status in ('active','draining','closed')),
    reason varchar(50),
    report_ids json not null check (json_array_length(report_ids) = 2),
    revision varchar(40) not null check (revision ~ '^[0-9a-f]{40}$'),
    model varchar(100) not null check (model = 'xai/grok-4.3'),
    starts_at timestamptz not null,
    expires_at timestamptz not null check (expires_at = starts_at + interval '60 minutes'),
    used_attempts integer not null default 0 check (used_attempts between 0 and 4),
    max_attempts integer not null default 4 check (max_attempts = 4),
    new_reports_admitted integer not null default 0 check (new_reports_admitted between 0 and 2),
    max_new_reports integer not null default 2 check (max_new_reports = 2),
    worker_owner uuid,
    worker_lease_until timestamptz,
    heartbeat_at timestamptz,
    last_success_at timestamptz
);
alter table wastegrid.tasks add column demo_run_id uuid references wastegrid.assessment_demo_runs(id);
alter table wastegrid.tasks add constraint assessment_demo_task_kind
    check (demo_run_id is null or kind in ('assessment','triage'));
create index tasks_demo_scope on wastegrid.tasks(demo_run_id,status,kind,created_at,id);
alter table wastegrid.assessment_demo_runs enable row level security;
revoke all on wastegrid.assessment_demo_runs from public,anon,authenticated;

create function wastegrid.preserve_assessment_demo_budget() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Assessment demo approval history cannot be deleted';
    end if;
    if new.id is distinct from old.id or new.scope_key is distinct from old.scope_key
        or new.report_ids::jsonb is distinct from old.report_ids::jsonb
        or new.revision is distinct from old.revision or new.model is distinct from old.model
        or new.starts_at is distinct from old.starts_at or new.expires_at is distinct from old.expires_at
        or new.max_attempts is distinct from old.max_attempts
        or new.max_new_reports is distinct from old.max_new_reports then
        raise exception 'Assessment demo approval and limits are immutable';
    end if;
    if new.used_attempts < old.used_attempts or new.new_reports_admitted < old.new_reports_admitted then
        raise exception 'Assessment demo counters cannot decrease';
    end if;
    if old.status <> 'active' and new.status = 'active' then
        raise exception 'Stopped assessment demo cannot be reactivated';
    end if;
    return new;
end $$;
create trigger preserve_assessment_demo_budget before update or delete on wastegrid.assessment_demo_runs
    for each row execute function wastegrid.preserve_assessment_demo_budget();
create function wastegrid.preserve_assessment_demo_binding() returns trigger language plpgsql as $$
begin
    if old.demo_run_id is not null and (new.demo_run_id is distinct from old.demo_run_id
        or new.kind is distinct from old.kind or new.payload::jsonb is distinct from old.payload::jsonb) then
        raise exception 'Assessment demo task scope is immutable';
    end if;
    return new;
end $$;
create trigger preserve_assessment_demo_binding before update on wastegrid.tasks
    for each row execute function wastegrid.preserve_assessment_demo_binding();
revoke all on function wastegrid.preserve_assessment_demo_budget() from public,anon,authenticated;
revoke all on function wastegrid.preserve_assessment_demo_binding() from public,anon,authenticated;
