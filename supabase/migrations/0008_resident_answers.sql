-- Resident claims are stored separately from image observations.
ALTER TABLE wastegrid.reports
    ADD COLUMN resident_answers jsonb NOT NULL DEFAULT '{}'::jsonb;
