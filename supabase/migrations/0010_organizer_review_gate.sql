-- An organizer's review request is independent of an in-flight AI assessment.
ALTER TABLE wastegrid.reports
    ADD COLUMN organizer_review_required boolean NOT NULL DEFAULT false;

-- Preserve pre-existing unresolved review states conservatively on upgrade.
UPDATE wastegrid.reports
SET organizer_review_required = true, needs_review = true
WHERE state = 'needs_review' OR needs_review = true;
