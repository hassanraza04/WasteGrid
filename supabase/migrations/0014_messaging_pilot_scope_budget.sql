-- A run UUID labels a pilot; it never grants another allowance for the same scope.
-- Canonical sets keep JSON order/duplicates from changing the lifetime budget key.
create function wastegrid.messaging_pilot_scope(
    project_id text, sender_id text, report_ids json, chat_ids json
) returns jsonb language sql immutable parallel safe as $$
    select jsonb_build_array(
        project_id,
        sender_id,
        (select coalesce(jsonb_agg(value order by value collate "C"), '[]'::jsonb)
            from (select distinct value::uuid::text as value from json_array_elements_text(report_ids)) reports),
        (select coalesce(jsonb_agg(value order by value collate "C"), '[]'::jsonb)
            from (select distinct value from json_array_elements_text(chat_ids)) chats)
    )
$$;
alter table wastegrid.messaging_pilots add column scope_key jsonb generated always as (
    wastegrid.messaging_pilot_scope(project_id,sender_id,report_ids,chat_ids)
) stored;
-- Existing duplicate scopes require explicit reconciliation rather than discarding usage.
alter table wastegrid.messaging_pilots add constraint messaging_pilots_scope_key unique(scope_key);

create function wastegrid.preserve_pilot_budget() returns trigger language plpgsql as $$
begin
    if tg_op = 'DELETE' then
        raise exception 'Messaging pilot budget history cannot be deleted';
    end if;
    if new.id is distinct from old.id
        or wastegrid.messaging_pilot_scope(new.project_id,new.sender_id,new.report_ids,new.chat_ids)
            is distinct from old.scope_key then
        raise exception 'Messaging pilot identity and scope are immutable';
    end if;
    if new.image_calls < old.image_calls or new.followup_calls < old.followup_calls
        or new.send_attempts < old.send_attempts then
        raise exception 'Messaging pilot usage cannot decrease';
    end if;
    return new;
end $$;
create trigger preserve_pilot_budget before update or delete on wastegrid.messaging_pilots
    for each row execute function wastegrid.preserve_pilot_budget();
revoke all on function wastegrid.messaging_pilot_scope(text,text,json,json) from public,anon,authenticated;
revoke all on function wastegrid.preserve_pilot_budget() from public,anon,authenticated;
