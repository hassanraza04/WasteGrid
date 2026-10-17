# WasteGrid dashboard

## Organizer dashboard

The organizer routes use Supabase email and password sign-in, then load shared
illustrative reports from the hosted WasteGrid API. Set these public values in
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
   `http://127.0.0.1:5173/admin/sign-in`.
2. Sign in with the privately supplied organizer account.
3. Confirm the organizer dashboard lists illustrative hosted reports.
4. Sign out and confirm `/admin` returns to sign-in.

## Customer demo boundary

Public customer report creation, tracking, and report storage remain a
browser-local demo in this release. Customer reports are not created in or read
from the hosted API.

## Checks

```bash
npm run test
npm run typecheck
npm run build
```
