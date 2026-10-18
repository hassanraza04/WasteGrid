# WasteGrid dashboard

## Organizer dashboard

The organizer routes use Supabase email and password sign-in, then load shared
reports from the hosted WasteGrid API. Real records are shown by default; the
illustrative-data checkbox exposes the labelled fixtures. Set these public values in
the ignored root `.env` file:

```text
VITE_API_BASE_URL=https://wastegrid-api-dev.onrender.com
VITE_SUPABASE_URL=https://PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
```

Only a Supabase publishable key belongs in browser configuration. Do not add a
Supabase secret or service-role key, an organizer password, or any messaging or
Photon key with a `VITE_` prefix.

1. Run `npm run dev` from `web` and open
   `http://127.0.0.1:5173/admin`.
2. Sign in with the privately supplied organizer account.
3. Confirm the organizer overview loads and open Reports.
4. Sign out and confirm `/admin` returns to sign-in.

## Demo entry and evidence

The public home page explains the Android resident/crew app and links to organizer
sign-in. Legacy `/report/*` URLs redirect there; browser-local prototype reports
are not submitted to the shared API. Use the installed Android app for the
resident and crew steps, with the organizer dashboard in a browser.

The report details page shows original evidence and private completion photos.
A completed cleanup without a submitted photo is labelled explicitly.

`npm run test:browser` exercises a fixture-backed organizer decision that creates
the same report's cleanup job before preview and dispatch. It is not evidence of
a live API, assessment worker, Android, or provider integration. Rehearse those
separately against one shared report before the presentation.

## Checks

```bash
npm run test
npm run typecheck
npm run build
```
