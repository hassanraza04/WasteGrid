# Hosted Organizer Dashboard Reconciliation Design

## Purpose

PR #13 is the merged source of truth for the hosted organizer dashboard. This
follow-up reshapes PR #15 so it no longer ships a second organizer sign-in,
session, API client, or dashboard. It restores the pre-existing browser-local
customer routes while retaining PR #13's hosted `/admin` experience.

## Scope

- Keep PR #13's `LiveApp` dashboard, its in-memory Supabase session, role
  check, paginated reports, signed photo access, request timeout, and access
  error handling.
- Restore the existing customer routes: `/`, `/report/new`, `/report/track`,
  and `/report/:reference`. They remain browser-local demo flows and are not
  represented as hosted reports.
- Keep `/admin` as the only organizer route. It must not have a second route
  guard, session adapter, API client, or report list.
- Retain the existing configuration fallback. A missing or malformed public
  dashboard configuration must display a useful organizer configuration error
  instead of leaving the browser blank.
- Remove PR #15's duplicate organizer files, their tests, and their stale
  documentation claims.

## Out of scope

- Changing the shared API contract, Supabase configuration, or backend CORS.
- Moving the customer demo to the hosted API.
- Replacing PR #13's organizer visual design or reducing its report details,
  pagination, photo access, or sign-out behavior.

## Architecture

`LiveApp` remains the web composition root. It reuses the existing customer
components, `BrowserReportRepository`, and `ReportErrorBoundary` for public
routes. Its `/admin/*` route continues to render the PR #13 dashboard and its
single organizer API client.

There is one Supabase browser client for organizers, configured by PR #13 with
an in-memory session. There is one hosted organizer API adapter. The removed
PR #15 session, API, and route-guard modules must have no remaining imports.

## Error handling

If organizer configuration cannot create the hosted API client, only the
organizer route shows a clear configuration error. Public customer routes must
remain usable. Access and report failures keep the existing PR #13 behavior.

## Validation

Tests are written first for the restored public routes and the malformed
configuration fallback. The complete web test suite, coverage threshold, type
check, and production build must pass after the branch is rebased on current
main. The final diff must contain no second organizer session, API client, or
dashboard implementation.
