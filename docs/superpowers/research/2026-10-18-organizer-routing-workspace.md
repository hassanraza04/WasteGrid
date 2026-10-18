# Organiser Routing Workspace Research

## Existing implementations found

- `web/src/live/OrganizerDashboard.tsx` owns organiser sign-in state, logout, and the session-expiry callback passed to child routes. Its `generation` and `mounted` guards prevent an older request from affecting a newer account.
- `web/src/live/organizerApi.ts` owns bearer-authenticated requests through `OrganizerApi.request`. It snapshots `sessionVersion` before each request, checks it after acquiring the token, response, and JSON body, and turns 401 or 403 into `AccessError`.
- `web/src/live/OrganizerJobDetails.tsx` is the closest data-loading component. It uses a local request generation plus `api.sessionVersion` to ignore stale success or error responses after unmount, route change, or account change.
- `web/src/live/OrganizerDashboard.test.tsx` exercises dashboard login and stale-session behavior with React Testing Library. `web/src/live/organizerApi.test.ts` asserts request paths, JSON bodies, safe errors, bearer headers, and session-version behavior.
- The reviewed routing contract is available from the backend branch at `docs/backend/scoped-routing.md`. It defines explicit `crew_ids` and `job_ids`, canonical returned job IDs, preview expiry, and dispatch retry rules.

## Conventions to follow

- Keep request logic in `OrganizerApi`; UI components should receive the API instance and call typed methods.
- Preserve the existing organiser session contract. A 401 or 403 must call the dashboard `onSessionExpired` callback only while the component request and API session version are current.
- Use a component `generation` ref and mounted guard for every asynchronous UI load, preview, dispatch, and refresh.
- Use `role="alert"` for safe action errors and `role="status"` for loading states. Do not render backend response bodies.
- Use `crypto.randomUUID()` in the browser to create one dispatch command ID. Keep that ID with its preview for uncertain failures; do not generate a second command on retry.
- Keep web tests in `web/src/live/*.test.tsx` or `web/src/live/*.test.ts`, using Vitest and React Testing Library.

## What must be built new

- Typed organiser API models and methods for `GET /crews`, paginated `GET /jobs?active_only=true&limit=100&offset=N`, `GET /plans/current`, `POST /routing/previews`, and `POST /routing/previews/{id}/dispatch`.
- A new `/admin/dispatch` route and organiser workspace that loads current routing state, lets an organiser explicitly select 1 to 5 crews and 1 to 25 jobs, and labels live versus illustrative data.
- Preview review UI showing selected scope, routes and stops, travel and service minutes, priority, exclusions, unassigned work, reassignments, expiry, and OSRM/OpenStreetMap attribution.
- Separate dispatch confirmation. It must refuse dispatch unless the returned canonical scope equals the requested scope and the preview is dispatchable, unexpired, undispatched, and has stops.
- Client-side preview invalidation on every crew or job selection change. A 409 clears the preview, keeps the selection, refreshes routing state, and requires a fresh computation and confirmation.

## Edge cases noted

- The current deployed backend may not yet recognize the scoped `job_ids` request. A 422 or an incompatible response must display a deployment or contract error. It must never retry by omitting `job_ids`.
- A chosen crew can have unfinished assigned jobs outside the chosen job scope. The backend will reject that scope with 409, but the UI should identify this before compute when the loaded job list is sufficient.
- A job assigned to an unselected crew must not be submitted in the explicit scope.
- `/jobs` is paginated, so the UI must read every page until a short page is returned. It must not silently rely on the first page.
- A stale result from a former account or unmounted component must neither change UI state nor log the current user out.
- A network or 5xx dispatch result is uncertain. It retains the same preview ID and command ID for an explicit retry. A definite 409 is not retried.
- `WG-8D724DBFF0D8` remains under review hold. The workspace must not mutate jobs as a side effect of loading or previewing.

## Input and output contracts required

- Preview input: `{ crew_ids: string[], job_ids: string[] }`, with 1 to 5 distinct crews and 1 to 25 distinct jobs.
- Preview output must expose `id`, `job_ids`, routes and stops, exclusions, unassigned work, reassignments, `dispatchable`, `expires_at`, and `plan_id`.
- The returned `job_ids` is canonical. Dispatch is enabled only when it is the same set and cardinality as the submitted IDs.
- Dispatch input: `{ command_id: string }`. A successful result has a `plan_id`.
- A 409 from dispatch is a definite conflict. Clear the local preview, retain selections, reload crews/jobs/current plan, and require a newly computed preview.
- Any 401 or 403 remains an `AccessError`; components pass it to the existing dashboard logout guard.
