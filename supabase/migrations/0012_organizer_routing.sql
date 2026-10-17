ALTER TABLE wastegrid.crews
    ADD COLUMN location_recorded_at timestamptz,
    ADD COLUMN location_received_at timestamptz,
    ADD COLUMN location_revision integer NOT NULL DEFAULT 0 CHECK (location_revision >= 0);
ALTER TABLE wastegrid.jobs ADD COLUMN collection_started_at timestamptz;
ALTER TABLE wastegrid.plans ADD COLUMN routing_mode varchar(20) NOT NULL DEFAULT 'legacy'
    CHECK (routing_mode IN ('legacy', 'organizer'));
CREATE TABLE wastegrid.routing_previews (
    id uuid PRIMARY KEY,
    payload json NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    dispatched_plan_id uuid REFERENCES wastegrid.plans(id),
    dispatch_command_id uuid UNIQUE,
    dispatched_by uuid,
    CHECK ((dispatched_plan_id IS NULL AND dispatch_command_id IS NULL AND dispatched_by IS NULL)
        OR (dispatched_plan_id IS NOT NULL AND dispatch_command_id IS NOT NULL AND dispatched_by IS NOT NULL))
);
ALTER TABLE wastegrid.routing_previews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wastegrid.routing_previews FROM PUBLIC, anon, authenticated;
