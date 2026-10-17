-- Application-owned history; the Photon ledger remains transport-owned.
create table wastegrid.conversation_messages (
    id uuid primary key,
    conversation_id uuid not null references wastegrid.conversations(id),
    direction varchar(10) not null check (direction in ('inbound', 'outbound')),
    body text not null check (length(body) between 1 and 4000 and length(btrim(body)) > 0),
    provider_message_id varchar(200),
    outgoing_message_id uuid unique references wastegrid.outgoing_messages(id),
    created_at timestamptz not null default now(),
    check ((direction = 'inbound' and provider_message_id is not null and outgoing_message_id is null)
        or (direction = 'outbound' and outgoing_message_id is not null))
);
create unique index conversation_messages_inbound_key
    on wastegrid.conversation_messages(conversation_id, provider_message_id)
    where direction = 'inbound';
create index conversation_messages_history_idx
    on wastegrid.conversation_messages(conversation_id, created_at, id);
create index conversations_report_idx on wastegrid.conversations(report_id);
alter table wastegrid.conversation_messages enable row level security;
revoke all on wastegrid.conversation_messages from public, anon, authenticated;

create function wastegrid.preserve_conversation_message() returns trigger language plpgsql as $$
begin
    raise exception 'Conversation history cannot be edited';
end $$;
create trigger preserve_conversation_message before update on wastegrid.conversation_messages
    for each row execute function wastegrid.preserve_conversation_message();
revoke all on function wastegrid.preserve_conversation_message() from public, anon, authenticated;
