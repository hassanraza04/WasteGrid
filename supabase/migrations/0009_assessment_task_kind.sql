-- Preserve existing task kinds while allowing the one-call assessment worker.
ALTER TABLE wastegrid.tasks DROP CONSTRAINT tasks_kind_check;
ALTER TABLE wastegrid.tasks ADD CONSTRAINT tasks_kind_check
    CHECK (kind IN ('triage', 'plan', 'followup', 'assessment'));
