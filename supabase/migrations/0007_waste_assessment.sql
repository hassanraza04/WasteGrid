-- Hackathon demo assessment rules; not an official municipal risk standard.
ALTER TABLE wastegrid.reports
    ADD COLUMN assessment_status text NOT NULL DEFAULT 'pending'
        CHECK (assessment_status IN ('pending', 'assessed', 'needs_review', 'failed')),
    ADD COLUMN priority text CHECK (priority IN ('high', 'medium', 'routine')),
    ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
    ADD COLUMN priority_reason text,
    ADD COLUMN assessment jsonb;
