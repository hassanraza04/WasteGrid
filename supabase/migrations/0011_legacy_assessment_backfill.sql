-- Migration 0007 gave pre-existing reports pending status without creating work.
-- Queue only unlinked reports that have usable photo metadata and have never had
-- an assessment task. Do not reassess existing jobs or replay previous attempts.
INSERT INTO wastegrid.tasks (id, kind, dedupe_key, payload)
SELECT gen_random_uuid(), 'assessment', 'assessment:' || r.id::text,
       json_build_object('report_id', r.id::text)
FROM wastegrid.reports r
JOIN wastegrid.photos p ON p.id = r.photo_id AND p.report_id = r.id
WHERE r.assessment_status = 'pending'
  AND r.job_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM wastegrid.tasks t
      WHERE t.kind = 'assessment' AND t.payload->>'report_id' = r.id::text
  )
ON CONFLICT (dedupe_key) DO NOTHING;

-- Missing photos or terminal/inconsistent old tasks must not leave an unlinked
-- report permanently pending. Permit an explicit audited organizer resolution.
UPDATE wastegrid.reports r
SET assessment_status = 'needs_review', needs_review = true,
    organizer_review_required = true, priority = NULL,
    priority_reason = 'Legacy report has no runnable assessment; organizer review required.',
    state = 'needs_review', version = version + 1
WHERE r.assessment_status = 'pending'
  AND r.job_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM wastegrid.tasks t
      WHERE t.kind = 'assessment' AND t.payload->>'report_id' = r.id::text
        AND t.status IN ('pending', 'running')
  );
