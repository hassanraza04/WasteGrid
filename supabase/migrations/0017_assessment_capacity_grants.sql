-- Explicit operator-approved capacity extensions retain counters and prior approvals.
-- Drop only the four known legacy budget constraints, never unrelated checks.
alter table wastegrid.assessment_demo_runs
    drop constraint assessment_demo_runs_max_attempts_check,
    drop constraint assessment_demo_runs_used_attempts_check,
    drop constraint assessment_demo_runs_max_new_reports_check,
    drop constraint assessment_demo_runs_new_reports_admitted_check;
alter table wastegrid.assessment_demo_runs
    add constraint assessment_demo_runs_max_attempts_check check (max_attempts between 4 and 100),
    add constraint assessment_demo_runs_used_attempts_check check (used_attempts between 0 and max_attempts),
    add constraint assessment_demo_runs_max_new_reports_check check (max_new_reports between 2 and 100),
    add constraint assessment_demo_runs_new_reports_admitted_check check (new_reports_admitted between 0 and max_new_reports);

create function wastegrid.require_initial_assessment_capacity() returns trigger language plpgsql as $$
begin
    if new.max_attempts <> 4 or new.max_new_reports <> 2 then
        raise exception 'Initial assessment capacity requires the original approval limits';
    end if;
    return new;
end $$;
create trigger require_initial_assessment_capacity before insert on wastegrid.assessment_demo_runs
    for each row execute function wastegrid.require_initial_assessment_capacity();
revoke all on function wastegrid.require_initial_assessment_capacity() from public,anon,authenticated;

create table wastegrid.assessment_demo_capacity_grants (
    id uuid primary key,
    run_id uuid not null references wastegrid.assessment_demo_runs(id),
    approved_at timestamptz not null,
    revision varchar(40) not null check (revision ~ '^[0-9a-f]{40}$'),
    reason text not null check (length(trim(reason)) between 1 and 1000),
    previous_max_attempts integer not null,
    max_attempts integer not null check (max_attempts between 4 and 100),
    previous_max_new_reports integer not null,
    max_new_reports integer not null check (max_new_reports between 2 and 100),
    previous_expires_at timestamptz not null,
    expires_at timestamptz not null,
    check (max_attempts - previous_max_attempts between 1 and 20),
    check (max_new_reports - previous_max_new_reports between 0 and 20),
    check (expires_at = approved_at + interval '60 minutes')
);
alter table wastegrid.assessment_demo_capacity_grants enable row level security;
revoke all on wastegrid.assessment_demo_capacity_grants from public,anon,authenticated;
create function wastegrid.preserve_assessment_capacity_grants() returns trigger language plpgsql as $$
begin raise exception 'Assessment capacity grants are append only'; end $$;
create trigger preserve_assessment_capacity_grants before update or delete on wastegrid.assessment_demo_capacity_grants
    for each row execute function wastegrid.preserve_assessment_capacity_grants();
revoke all on function wastegrid.preserve_assessment_capacity_grants() from public,anon,authenticated;

create or replace function wastegrid.preserve_assessment_demo_budget() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then raise exception 'Assessment demo approval history cannot be deleted'; end if;
    if new.id is distinct from old.id or new.scope_key is distinct from old.scope_key
        or new.report_ids::jsonb is distinct from old.report_ids::jsonb or new.model is distinct from old.model
        or new.starts_at is distinct from old.starts_at then
        raise exception 'Assessment demo approval and limits are immutable';
    end if;
    if new.used_attempts < old.used_attempts or new.new_reports_admitted < old.new_reports_admitted then
        raise exception 'Assessment demo counters cannot decrease';
    end if;
    if new.max_attempts is distinct from old.max_attempts
        or new.max_new_reports is distinct from old.max_new_reports then
        if not (old.status = 'closed' and old.reason in ('attempt_limit','window_expired')
            and old.worker_owner is null and new.worker_owner is null
            and new.status = 'active' and new.reason is null
            and new.used_attempts = old.used_attempts
            and new.new_reports_admitted = old.new_reports_admitted
            and new.max_attempts > old.max_attempts
            and new.max_new_reports >= old.max_new_reports
            and new.current_window_started_at between statement_timestamp() - interval '1 minute' and statement_timestamp() + interval '1 minute'
            and new.expires_at = new.current_window_started_at + interval '60 minutes'
            and exists (select 1 from wastegrid.assessment_demo_capacity_grants g
                where g.run_id = old.id and g.previous_max_attempts = old.max_attempts
                and g.max_attempts = new.max_attempts
                and g.previous_max_new_reports = old.max_new_reports
                and g.max_new_reports = new.max_new_reports
                and g.previous_expires_at = old.expires_at
                and g.approved_at = new.current_window_started_at
                and g.expires_at = new.expires_at and g.revision = new.revision)) then
            raise exception 'Assessment capacity changes require an explicit audited grant on a drained run';
        end if;
        if exists (select 1 from wastegrid.tasks where demo_run_id = old.id
            and (status = 'running' or (kind = 'triage' and status = 'pending'))) then
            raise exception 'Assessment work must drain before granting capacity';
        end if;
        return new;
    end if;
    if new.revision is distinct from old.revision or new.expires_at is distinct from old.expires_at
        or new.current_window_started_at is distinct from old.current_window_started_at
        or (old.status <> 'active' and new.status = 'active') then
        if not (old.status = 'closed' and old.reason = 'window_expired' and old.expires_at <= statement_timestamp()
            and old.worker_owner is null and new.worker_owner is null
            and new.status = 'active' and new.reason is null
            and new.used_attempts = old.used_attempts and new.new_reports_admitted = old.new_reports_admitted
            and new.used_attempts < new.max_attempts and new.new_reports_admitted < new.max_new_reports
            and new.current_window_started_at >= statement_timestamp() - interval '1 minute'
            and new.current_window_started_at <= statement_timestamp() + interval '1 minute'
            and new.current_window_started_at > old.expires_at
            and new.expires_at = new.current_window_started_at + interval '60 minutes') then
            raise exception 'Only an expired, drained assessment window can reopen without changing counters';
        end if;
        if exists (select 1 from wastegrid.tasks where demo_run_id = old.id
            and (status = 'running' or (kind = 'triage' and status = 'pending'))) then
            raise exception 'Assessment work must drain before reopening';
        end if;
        insert into wastegrid.assessment_demo_window_history
            (run_id,previous_revision,revision,previous_expires_at,opened_at,expires_at,used_attempts,new_reports_admitted)
        values (old.id,old.revision,new.revision,old.expires_at,new.current_window_started_at,new.expires_at,new.used_attempts,new.new_reports_admitted);
    end if;
    return new;
end $$;
