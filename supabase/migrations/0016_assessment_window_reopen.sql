-- Reopen an expired window without replacing the original approval or its budget.
alter table wastegrid.assessment_demo_runs add column current_window_started_at timestamptz;
update wastegrid.assessment_demo_runs set current_window_started_at = starts_at;
alter table wastegrid.assessment_demo_runs alter column current_window_started_at set not null;
do $$ declare constraint_name text; begin
    for constraint_name in select conname from pg_constraint
        where conrelid = 'wastegrid.assessment_demo_runs'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%expires_at%'
    loop execute format('alter table wastegrid.assessment_demo_runs drop constraint %I', constraint_name); end loop;
end $$;
alter table wastegrid.assessment_demo_runs add constraint assessment_demo_current_window
    check (current_window_started_at >= starts_at and expires_at = current_window_started_at + interval '60 minutes');

create table wastegrid.assessment_demo_window_history (
    id bigint generated always as identity primary key,
    run_id uuid not null references wastegrid.assessment_demo_runs(id),
    previous_revision varchar(40) not null,
    revision varchar(40) not null,
    previous_expires_at timestamptz not null,
    opened_at timestamptz not null,
    expires_at timestamptz not null,
    used_attempts integer not null,
    new_reports_admitted integer not null
);
alter table wastegrid.assessment_demo_window_history enable row level security;
revoke all on wastegrid.assessment_demo_window_history from public,anon,authenticated;
create function wastegrid.preserve_assessment_window_history() returns trigger language plpgsql as $$
begin raise exception 'Assessment window history is append only'; end $$;
create trigger preserve_assessment_window_history before update or delete on wastegrid.assessment_demo_window_history
    for each row execute function wastegrid.preserve_assessment_window_history();
revoke all on function wastegrid.preserve_assessment_window_history() from public,anon,authenticated;

create or replace function wastegrid.preserve_assessment_demo_budget() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then raise exception 'Assessment demo approval history cannot be deleted'; end if;
    if new.id is distinct from old.id or new.scope_key is distinct from old.scope_key
        or new.report_ids::jsonb is distinct from old.report_ids::jsonb or new.model is distinct from old.model
        or new.starts_at is distinct from old.starts_at
        or new.max_attempts is distinct from old.max_attempts
        or new.max_new_reports is distinct from old.max_new_reports then
        raise exception 'Assessment demo approval and limits are immutable';
    end if;
    if new.used_attempts < old.used_attempts or new.new_reports_admitted < old.new_reports_admitted then
        raise exception 'Assessment demo counters cannot decrease';
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
