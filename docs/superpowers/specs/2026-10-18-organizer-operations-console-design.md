# Organizer Operations Console Design

## Goal

Give organizers one web dashboard for inspecting reports, reviewing AI output,
making accountable operational decisions, and later preparing or dispatching
routes. Messaging remains outside this work while the pilot is disabled.

## Scope and delivery order

This work has two independent surfaces. Build them in order.

1. Report operations adds a detailed report screen and confirmed organizer
   decisions. It supports reports such as the current Chalk-assessed
   `needs_review` report.
2. Routing and dispatch adds a separate route workspace once approved jobs and
   fresh crew locations are available.

The report list remains at `/admin`. It stays compact and shows summary fields,
with each title or reference linking to `/admin/reports/:reportId`.

## Report operations

The report details page loads `GET /organizer/reports/{reportId}` using the
existing authenticated organizer API client. It presents these sections in this
order:

1. Identity and current status: public reference, title, location, timestamps,
   linked job, priority, assessment status, and review state.
2. Evidence: private report photo and resident-provided description or answers.
3. Chalk assessment: description, size, obstruction and level, traffic risk,
   special handling, visible fire or sharp-object signals, confidence, model
   reason, and consistency with resident context.
4. Operational record: current triage recommendation, existing job details when
   linked, and the server-provided event timeline.
5. Organizer decision: an editable form based on the current triage data.

The organizer decision form can set category, equipment, duplicate candidate
and confirmation, hazard, evidence sufficiency, missing information, decision
summary, evidence reports, next action, estimated service minutes, and priority.
It does not permit a person to erase the stored AI observations.

Edits remain local until the organizer selects **Review decision**. The review
screen presents a clear summary of changes. **Apply organizer decision** sends
one confirmed request with a fresh command ID and the report's current version.
The user sees the refreshed server response only after a successful save.

Priority is sent through its existing dedicated API with its own fresh command
ID and expected report version. It is part of the same review summary but is
submitted only after the triage decision succeeds and returns the latest report
version.

If the backend rejects a stale version, duplicate command, malformed decision,
or unavailable service, the page keeps unsaved edits on screen, displays the
safe server outcome, and asks the organizer to refresh before trying again.

## Routing and dispatch

The later routing workspace is a separate `/admin/dispatch` route. It uses the
existing organizer-protected crew, active-job, route-preview, and dispatch APIs.
It shows selected crews, eligible jobs, exclusions, unassigned jobs, proposed
routes, travel label, and OpenStreetMap attribution with a map-correction link.

Computing a preview is read-only with respect to assignments. Dispatch is a
separate explicit confirmation using the returned preview ID and a fresh command
ID. The screen does not silently retry a failed compute or dispatch.

## Security and operational constraints

- Require the existing Supabase organizer session for every read and mutation.
- Fetch private photos through the current short-lived signed-photo endpoint.
- Never display the resident access token, Supabase server key, Chalk key, or
  signed URL as page text.
- Keep messaging, worker controls, and provider credentials out of the web UI.
- Preserve backend optimistic-concurrency and idempotency requirements. The web
  client must not invent a fallback decision when a request fails.
- Keep the report list summary-oriented. Detailed assessment fields appear only
  on the selected report page.

## Testing

Add browser-component and API-adapter tests for:

- linking from the report list to a detail page
- rendering an assessed report, including `needs_review` results
- loading and renewing a private photo without exposing its URL in text
- preserving form edits after a rejected stale decision
- submitting one command ID and expected version for a confirmed decision
- applying priority after a successful triage response with the refreshed
  version
- keeping routing preview and dispatch as distinct explicit actions
- excluding messaging controls from the organizer UI

Run the existing web test suite, TypeScript check, lint, and a hosted browser
smoke test with the organizer account after implementation.
