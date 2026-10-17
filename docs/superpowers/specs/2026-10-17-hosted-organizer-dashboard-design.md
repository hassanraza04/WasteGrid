# Hosted Organizer Dashboard Design

## Purpose

Connect the organizer dashboard to the shared development API while preserving
the existing browser-local customer demo. Organizers must be able to sign in
with Supabase and load the illustrative reports from the hosted API.

## Scope

This change applies only to the organizer routes:

- `/admin/sign-in` becomes an email and password sign-in form backed by
  Supabase Auth.
- `/admin` requires an authenticated Supabase user whose API identity has the
  `organizer` role.
- `/admin` loads reports from `GET /organizer/reports` at the configured hosted
  API origin.

The customer routes remain browser-local demo flows. Their reports are not
shared with the backend in this release. This boundary is stated in the web
README and dashboard handoff documentation.

## Configuration and security

The browser receives only these public Vite settings:

```text
VITE_API_BASE_URL
VITE_SUPABASE_URL
VITE_SUPABASE_PUBLISHABLE_KEY
```

The app must not expose organizer passwords, Supabase server keys, messaging
keys, Photon keys, or any other server secret. Supabase owns browser session
storage and token refresh. API requests use the current Supabase user access
token as `Authorization: Bearer <token>`.

## Architecture

Two small browser-facing adapters isolate remote work from React components:

- A Supabase organizer session adapter signs in, signs out, reads the current
  access token, and reports whether a session exists.
- A hosted organizer report client calls `/auth/me` to verify the organizer
  role and calls `/organizer/reports` to retrieve the list.

The admin route components own request state and render semantic loading and
failure states. They do not call Supabase or `fetch` directly. The current
local `BrowserReportRepository` remains available only for customer routes.

## Flow

1. An organizer enters their email and password at `/admin/sign-in`.
2. The session adapter calls Supabase `signInWithPassword`.
3. On success, the dashboard obtains the Supabase access token and calls
   `/auth/me` on the configured API.
4. A response whose role is `organizer` grants access to `/admin`.
5. The dashboard sends the same bearer token to `/organizer/reports` and
   renders the returned report references.
6. Sign-out clears the Supabase session and returns to the sign-in page.

## Errors

- Invalid credentials stay on the sign-in page with a clear message.
- A missing browser configuration produces a configuration error rather than a
  partial request.
- An expired or invalid token signs the organizer out and returns them to
  sign-in.
- A non-organizer identity receives an unauthorized state and no report data.
- A report request failure displays a retryable error without showing stale
  local demo reports as if they came from the API.

## Validation

Vitest and React Testing Library cover successful sign-in, failed sign-in,
organizer-role verification, report loading, unauthorized access, and report
loading failure. Type checking and the complete web test suite must pass.

Manual acceptance uses `http://127.0.0.1:5173` with the hosted API and the
privately supplied organizer account. It confirms `/auth/me` identifies the
organizer and the dashboard displays the shared illustrative reports.
