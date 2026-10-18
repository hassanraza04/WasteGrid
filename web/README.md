# WasteGrid web app

The web app provides the live organizer console at `/admin` and a public landing
page directing residents and crews to the Android app. It uses React, TypeScript,
Vite, React Router, and Leaflet.
See the [project README](../README.md) for the system overview.

## Setup

Use Node.js 22.22.2 or newer and npm. From the repository root:

```bash
test -f .env.local || cp web/.env.example .env.local
```

Set these public values in the **root** `.env.local`:

```dotenv
VITE_API_BASE_URL=https://wastegrid-api-dev.onrender.com
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=REPLACE_WITH_PUBLIC_PUBLISHABLE_KEY
```

The API and Supabase values must refer to the same environment. Vite's
[`envDir: ".."`](vite.config.ts) loads environment files from the repository root;
`web/.env.local` is not the configured source. Existing root `.env` values are
also available to Vite, with `.env.local` taking precedence. Only variables with
Vite's public prefix belong in browser configuration; use that prefix only for
values intended to be public. Never put a Supabase secret/service-role key,
organizer password, resident token, Photon key, or Chalk key in a `VITE_` variable.

Start from the repository root:

```bash
cd web
npm ci
npm run dev -- --host 127.0.0.1
```

Open [the organizer dashboard](http://127.0.0.1:5173/admin). Restart Vite after
changing configuration. A provisioned Supabase email/password account must have
the protected organizer role returned by the backend's `/auth/me`.

## Routes and data

| Route | Behavior |
| --- | --- |
| `/admin` | Supabase sign-in, then the operational overview. |
| `/admin/reports` | Server-filtered report listing; real reports by default with a labeled illustrative-data toggle. |
| `/admin/reports/:reportId` | Authorized report details, photos, history, and organizer decisions. |
| `/admin/dispatch` | Live crew/job selection, route preview, review, and confirmed dispatch. |
| `/` | Branded welcome page with Android resident/crew guidance and organizer sign-in. |
| `/report/*` | Redirects to the welcome page. |

`src/main.tsx` mounts `LiveApp`. Earlier customer prototype code and storage
tests remain in source, but those pages are no longer mounted. Their old reports
never entered the hosted API. Use the [native mobile app](../mobile/README.md)
for connected resident reporting.

## Organizer workflow

1. Sign in and inspect Overview, Reports, and Routing. Operational views refresh
   every 15 seconds while foregrounded. Open a report to inspect its assessment,
   review requirements, history, and authorized original/completion photos.
2. Resolve review cases using the available version-checked organizer actions.
   A reference alone grants no private report access.
3. Open **Routing dispatch** and select the intended crews and jobs. Include
   every unfinished assignment of a selected crew.
4. Compute and inspect the preview, then choose **Review dispatch** and
   **Confirm and dispatch**. Previewing leaves assignments unchanged.
5. If dispatch has an uncertain response, use its recovery action. A definite
   conflict requires a current-state refresh, a new preview, and renewed approval.

The workspace sends explicit crew/job scope and duration, stop, return-to-start,
and partial-dispatch constraints. It gates computation on fresh selected-crew GPS
and explains provider or eligibility failures. Partial work needs explicit
acknowledgement. Browser IndexedDB preserves the account/environment-specific
selection, reviewed proposal, command, and attempt barrier across reloads.
Storage failure blocks submission. A committed dispatch exposes its receipt and
printable crew route card.

Road geometry is loaded separately from numerical travel estimates; unavailable
geometry stays labeled. Routing needs the matching API, enabled organizer routing,
a road-time provider, and fresh crew locations. See
[scoped routing](../docs/backend/scoped-routing.md) and the
[operator runbook](../docs/backend/organizer-prototype.md).

Sessions remain in memory and refresh while the page is open. Reloading requires
sign-in again. Signing out or losing authorization clears the organizer view.
Photos are obtained through the authorized API access endpoint.

## Source layout

- `src/live/`: authenticated API client, operational pages, road map, and durable dispatch journal.
- `src/customer/`: earlier resident browser prototype retained for its tests.
- `src/data/`: browser storage repository and repository interface.
- `src/domain/`: browser demo types and presentation rules.
- `src/test/`: shared test setup; tests also live beside source files.
- `e2e/`: fixture-backed responsive Playwright browser walkthroughs.

## Checks and production build

Run from `web/`:

```bash
npm test
npm run coverage
npm run typecheck
npm run build
```

`npm run build` includes TypeScript checks and outputs `dist/`. A static host
must rewrite application routes to `index.html`. Set public environment values
when building for the intended API and permit that browser origin on the backend.
[`render.organizer.yaml`](../render.organizer.yaml) defines the static site.

For responsive browser checks, install the matching Playwright Chromium runtime
and run from `web/` with port 5173 free:

```bash
npx playwright install chromium
npm run test:browser
```

Playwright starts its own fixture-configured Vite server. The walkthrough does
not establish live Auth, assessment, Android, GPS, or provider acceptance.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Sign-in configuration error | All three public variables are set in the root environment file; restart Vite. |
| Browser requests blocked | Backend `CORS_ORIGINS` must include the exact origin. `http://127.0.0.1:5173` and `http://localhost:5173` differ. |
| Valid account cannot open organizer data | Its protected backend role must be organizer; a Supabase login alone does not grant that role. |
| A customer report is absent from `/admin/reports` | Earlier browser prototype reports were local. Submit through native mobile; check the real/illustrative filter. |
| Routing unavailable or rejected | Check feature flags, current API contract, crew GPS, review eligibility, and complete selected crew scope. |

See the [demo guide](../docs/demo.md), [backend setup](../docs/backend/setup.md),
and [documentation index](../docs/README.md) for the remaining components.
