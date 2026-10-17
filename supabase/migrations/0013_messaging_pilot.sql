-- Private, bounded resident messaging. Existing conversation IDs remain report links.
alter table wastegrid.tasks drop constraint tasks_kind_check;
alter table wastegrid.tasks add constraint tasks_kind_check
    check (kind in ('triage','plan','followup','assessment','pilot_followup'));
create table wastegrid.messaging_pilots (
    id uuid primary key,
    project_id varchar(200) not null,
    sender_id varchar(200) not null,
    report_ids json not null default '[]',
    chat_ids json not null default '[]',
    image_calls integer not null default 0 check (image_calls between 0 and 2),
    followup_calls integer not null default 0 check (followup_calls between 0 and 12),
    send_attempts integer not null default 0 check (send_attempts between 0 and 30),
    created_at timestamptz not null default now()
);
create table wastegrid.messaging_threads (
    id uuid primary key,
    pilot_id uuid references wastegrid.messaging_pilots(id),
    channel varchar(30) not null,
    external_id varchar(200) not null,
    project_id varchar(200) not null default '',
    sender_id varchar(200) not null default '',
    peer_id varchar(200) not null default '',
    paused boolean not null default false,
    consent_revision integer not null default 1,
    selected_link_id uuid,
    selection_expires_at timestamptz,
    pending_text text,
    pending_inbound_id uuid,
    pending_expires_at timestamptz,
    last_input_at timestamptz,
    last_control_at timestamptz,
    created_at timestamptz not null default now(),
    unique(channel, external_id)
);
alter table wastegrid.conversations add column thread_id uuid references wastegrid.messaging_threads(id);
alter table wastegrid.conversations add column active boolean not null default true;
-- Every old channel/space was unique, so its existing link UUID can also seed the thread.
insert into wastegrid.messaging_threads(id, channel, external_id, created_at)
    select id, channel, external_id, created_at from wastegrid.conversations;
update wastegrid.conversations set thread_id=id;
alter table wastegrid.conversations drop constraint conversations_channel_external_id_key;
create unique index conversations_thread_report_key on wastegrid.conversations(thread_id,report_id);
-- Legacy callers may still create an unthreaded one-report link.
create unique index conversations_legacy_space_key on wastegrid.conversations(channel,external_id) where thread_id is null;
create table wastegrid.messaging_inbound (
    id uuid primary key,
    thread_id uuid not null references wastegrid.messaging_threads(id),
    project_id varchar(200) not null,
    provider_message_id varchar(200) not null,
    payload_hash varchar(64) not null,
    body text not null,
    provider_created_at timestamptz not null,
    received_at timestamptz not null default now(),
    conversation_id uuid references wastegrid.conversations(id),
    report_id uuid references wastegrid.reports(id),
    consent_revision integer not null,
    status varchar(30) not null default 'received',
    model_attempted boolean not null default false,
    interpretation json,
    last_error varchar(100),
    unique(project_id,provider_message_id)
);
create index messaging_inbound_thread_order on wastegrid.messaging_inbound(thread_id,received_at,id);
create table wastegrid.messaging_outgoing (
    id uuid primary key,
    thread_id uuid not null references wastegrid.messaging_threads(id),
    conversation_id uuid references wastegrid.conversations(id),
    event_id uuid references wastegrid.events(id),
    kind varchar(50) not null,
    text text not null check (length(text) between 1 and 4000 and length(btrim(text)) > 0),
    external_id varchar(200) not null,
    sender_id varchar(200) not null,
    consent_revision integer not null,
    allow_paused boolean not null default false,
    status varchar(30) not null default 'pending',
    attempts integer not null default 0 check (attempts between 0 and 3),
    lease_id uuid,
    leased_until timestamptz,
    next_attempt_at timestamptz not null default now(),
    provider_message_id varchar(200),
    provider_status varchar(30),
    accepted_at timestamptz,
    delivered_at timestamptz,
    last_error varchar(100),
    created_at timestamptz not null default now()
);
create unique index messaging_outgoing_event_link on wastegrid.messaging_outgoing(event_id,conversation_id) where event_id is not null and conversation_id is not null;
create index messaging_outgoing_due on wastegrid.messaging_outgoing(status,next_attempt_at,created_at);
-- Preserve the existing report transcript API, including its immutable-history trigger.
alter table wastegrid.conversation_messages add column pilot_outgoing_id uuid unique references wastegrid.messaging_outgoing(id);
alter table wastegrid.conversation_messages drop constraint conversation_messages_check;
alter table wastegrid.conversation_messages add constraint conversation_messages_check check (
    (direction='inbound' and provider_message_id is not null and outgoing_message_id is null and pilot_outgoing_id is null)
    or (direction='outbound' and num_nonnulls(outgoing_message_id,pilot_outgoing_id)=1)
);
create function wastegrid.preserve_pilot_envelope() returns trigger language plpgsql as $$
begin
    if (new.text,new.external_id,new.sender_id,new.thread_id,new.conversation_id,new.consent_revision,new.kind,new.allow_paused,new.event_id)
        is distinct from (old.text,old.external_id,old.sender_id,old.thread_id,old.conversation_id,old.consent_revision,old.kind,old.allow_paused,old.event_id) then
        raise exception 'Messaging envelope is immutable';
    end if;
    if old.provider_message_id is not null and new.provider_message_id is distinct from old.provider_message_id then
        raise exception 'Provider submission identity is immutable';
    end if;
    return new;
end $$;
create trigger preserve_pilot_envelope before update on wastegrid.messaging_outgoing
    for each row execute function wastegrid.preserve_pilot_envelope();
revoke all on function wastegrid.preserve_pilot_envelope() from public,anon,authenticated;
do $$ declare t text; begin
    foreach t in array array['messaging_pilots','messaging_threads','messaging_inbound','messaging_outgoing'] loop
        execute format('alter table wastegrid.%I enable row level security',t);
        execute format('revoke all on wastegrid.%I from public,anon,authenticated',t);
    end loop;
end $$;
