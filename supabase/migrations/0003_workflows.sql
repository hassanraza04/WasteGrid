alter table wastegrid.crews add column version integer not null default 1 check (version > 0);
alter table wastegrid.jobs add column held boolean not null default false;
alter table wastegrid.jobs add column route_position integer check (route_position >= 0);
alter table wastegrid.jobs add column travel_minutes double precision not null default 0 check (travel_minutes >= 0);
alter table wastegrid.jobs add column decision_summary text not null default '';
alter table wastegrid.reports add column clarifications json not null default '[]';
alter table wastegrid.reports add column triage json;
alter table wastegrid.reports add column request_hash varchar(64);
alter table wastegrid.events add column actor varchar(100) not null default 'system';
alter table wastegrid.outgoing_messages add column lease_id uuid;
alter table wastegrid.outgoing_messages add column leased_until timestamptz;
alter table wastegrid.outgoing_messages add column attempts integer not null default 0;
alter table wastegrid.outgoing_messages add column next_attempt_at timestamptz not null default now();
alter table wastegrid.outgoing_messages add column last_error text;
create table wastegrid.tasks (
    id uuid primary key,
    kind varchar(30) not null check (kind in ('triage','plan','followup')),
    dedupe_key varchar(200) not null unique,
    payload json not null default '{}',
    status varchar(20) not null default 'pending' check (status in ('pending','running','succeeded','failed')),
    attempts integer not null default 0,
    lease_id uuid,
    leased_until timestamptz,
    next_attempt_at timestamptz not null default now(),
    last_error text,
    result json,
    created_at timestamptz not null default now()
);
create index tasks_pending_idx on wastegrid.tasks(status, next_attempt_at);
alter table wastegrid.tasks enable row level security;
revoke all on wastegrid.tasks from public, anon, authenticated;
