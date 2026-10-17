-- Run against Supabase, after the core schema. Auth users are provisioned there.
alter table wastegrid.staff_roles add constraint staff_auth_user_fk
    foreign key (user_id) references auth.users(id) on delete cascade;

-- No storage.objects policies are added for anon/authenticated. The backend
-- privileged key mediates uploads and authorizes short-lived download URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-photos', 'report-photos', false, 8388608,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 8388608,
    allowed_mime_types = excluded.allowed_mime_types;

