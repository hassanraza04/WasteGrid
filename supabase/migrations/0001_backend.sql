-- Person 2 foundation. Private schema: clients reach it only through FastAPI.
create schema if not exists wastegrid;
revoke all on schema wastegrid from public, anon, authenticated;

create table wastegrid.crews (
    id uuid primary key,
    name varchar(100) not null,
    equipment json not null check (json_typeof(equipment) = 'array'),
    shift_minutes integer not null check (shift_minutes > 0 and shift_minutes <= 1440),
    available boolean not null default true,
    start_location json not null,
    illustrative boolean not null default false
);
create table wastegrid.staff_roles (
    user_id uuid primary key,
    role varchar(20) not null check (role in ('organizer', 'crew')),
    crew_id uuid references wastegrid.crews(id),
    check ((role = 'crew' and crew_id is not null) or (role = 'organizer' and crew_id is null))
);
create table wastegrid.jobs (
    id uuid primary key,
    status varchar(30) not null default 'unassigned'
        check (status in ('unassigned','assigned','in_progress','blocked','completed','recheck_requested')),
    location json not null,
    category varchar(100) not null,
    required_equipment json not null check (json_typeof(required_equipment) = 'array'),
    estimated_service_minutes integer not null check (estimated_service_minutes > 0),
    assigned_crew_id uuid references wastegrid.crews(id),
    locked boolean not null default false,
    unassigned_reason text,
    version integer not null default 1 check (version >= 1),
    illustrative boolean not null default false,
    check (status not in ('assigned', 'in_progress', 'completed') or assigned_crew_id is not null),
    check (status <> 'unassigned' or assigned_crew_id is null)
);
create table wastegrid.reports (
    id uuid primary key,
    token_hash varchar(64) not null check (length(token_hash) = 64),
    state varchar(30) not null default 'received'
        check (state in ('received','needs_info','needs_review','linked_to_job')),
    location json,
    note text,
    photo_id uuid not null,
    job_id uuid references wastegrid.jobs(id),
    version integer not null default 1 check (version >= 1),
    illustrative boolean not null default false,
    created_at timestamptz not null default now(),
    check ((state = 'linked_to_job') = (job_id is not null))
);
create table wastegrid.photos (
    id uuid primary key,
    object_path varchar(300) not null unique,
    content_type varchar(50) not null check (content_type in ('image/jpeg','image/png','image/webp')),
    size_bytes integer not null check (size_bytes > 0 and size_bytes <= 8388608),
    report_id uuid references wastegrid.reports(id),
    job_id uuid references wastegrid.jobs(id),
    created_at timestamptz not null default now(),
    check ((report_id is null) <> (job_id is null))
);
alter table wastegrid.reports add constraint reports_photo_fk
    foreign key (photo_id) references wastegrid.photos(id) deferrable initially deferred;

create table wastegrid.link_codes (
    id uuid primary key,
    code_hash varchar(64) not null unique,
    report_id uuid not null references wastegrid.reports(id),
    expires_at timestamptz not null,
    consumed_at timestamptz
);
create table wastegrid.conversations (
    id uuid primary key,
    report_id uuid not null references wastegrid.reports(id),
    channel varchar(30) not null check (channel in ('imessage','telegram','whatsapp','sms')),
    external_id varchar(200) not null,
    created_at timestamptz not null default now(),
    unique (channel, external_id)
);
create table wastegrid.events (
    id uuid primary key,
    report_id uuid references wastegrid.reports(id),
    job_id uuid references wastegrid.jobs(id),
    crew_id uuid references wastegrid.crews(id),
    kind varchar(50) not null,
    command_id uuid unique,
    request_hash varchar(64),
    details json not null default '{}',
    created_at timestamptz not null default now(),
    check (num_nonnulls(report_id, job_id, crew_id) = 1),
    check ((command_id is null) = (request_hash is null))
);
create table wastegrid.outgoing_messages (
    id uuid primary key,
    event_id uuid not null references wastegrid.events(id),
    conversation_id uuid not null references wastegrid.conversations(id),
    payload json not null,
    delivered_at timestamptz,
    created_at timestamptz not null default now(),
    unique (event_id, conversation_id)
);
create table wastegrid.plans (
    id uuid primary key,
    payload json not null,
    stale boolean not null default false,
    created_at timestamptz not null default now()
);
create table wastegrid.assignments (
    id uuid primary key,
    plan_id uuid not null references wastegrid.plans(id),
    job_id uuid not null references wastegrid.jobs(id),
    crew_id uuid not null references wastegrid.crews(id),
    position integer not null check (position >= 0),
    unique (plan_id, job_id),
    unique (plan_id, crew_id, position)
);
create index reports_job_idx on wastegrid.reports(job_id);
create index reports_created_idx on wastegrid.reports(created_at desc);
create index jobs_crew_idx on wastegrid.jobs(assigned_crew_id);
create index events_report_idx on wastegrid.events(report_id, created_at);
create index events_job_idx on wastegrid.events(job_id, created_at);
create index photos_report_idx on wastegrid.photos(report_id);
create index photos_job_idx on wastegrid.photos(job_id);
create index outbox_pending_idx on wastegrid.outgoing_messages(created_at) where delivered_at is null;

-- Defense in depth: no direct browser/mobile access, even if schema is exposed.
do $$ declare t record; begin
    for t in select tablename from pg_tables where schemaname = 'wastegrid' loop
        execute format('alter table wastegrid.%I enable row level security', t.tablename);
        execute format('revoke all on wastegrid.%I from public, anon, authenticated', t.tablename);
    end loop;
end $$;
alter default privileges in schema wastegrid revoke all on tables from public, anon, authenticated;

