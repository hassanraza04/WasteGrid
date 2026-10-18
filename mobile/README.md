# WasteGrid mobile app

The native app connects residents, organizers, and cleanup crews to the WasteGrid
API. It uses Expo SDK 58, React Native, TypeScript, and Expo Router. The
[project README](../README.md) explains the full system.

## Setup

Use Node.js 22.22.2 or newer and npm. From the repository root:

```bash
cd mobile
test -f .env.local || cp .env.example .env.local
```

Set the public values in `mobile/.env.local`:

```dotenv
EXPO_PUBLIC_API_BASE_URL=https://wastegrid-api-dev.onrender.com
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=REPLACE_WITH_PUBLIC_PUBLISHABLE_KEY
```

The API and Supabase configuration must refer to the same environment. Only the
publishable key belongs here; database credentials, service-role keys, staff
passwords, resident tokens, and provider keys must not be placed in public
variables. Restart the development server after changing values.

From `mobile/`, install and start:

```bash
npm ci
npm start
```

Open a compatible native development build or Expo Go runtime. The project also
has `npm run android` and `npm run ios` for local native builds with the respective
platform toolchains installed. `npm run web` is useful for a browser preview;
durable report and crew submissions require native storage and are unavailable
in Expo web.

For a backend on your own computer, start it with `--host 0.0.0.0`, use a reachable
LAN address such as `http://YOUR_LAN_IP:8000`, and connect the phone to that
network. The phone's `localhost` does not point to your computer.

## Roles and screens

| Role | Connected workflow |
| --- | --- |
| Resident (`user` in the app) | Map, photo reporting, account, and private report history on the current device. |
| Organizer (`admin` in the app) | Resident screens plus **Dispatch** for crew/job selection, routing controls, previews, and approval. |
| Crew (`crew` in the app) | Resident screens plus **My route** for its own ordered stops, foreground location, starts, and completion. |

Sign in through the account/avatar control. Supabase authenticates the account;
`/auth/me` determines its protected staff role and crew ID. A verified account
without a staff role is a resident. Existing accounts must be provisioned first;
there is no in-app sign-up. Native sessions use SecureStore, restore with backend
role verification, and refresh while the app is foregrounded. Web sessions stay
in memory.

Anonymous report submission is supported. **My reports** requires sign-in and
filters locally saved reports by account. A signed-in resident can explicitly
import earlier anonymous drafts from the same device. History does not sync
across devices, and a public reference cannot replace a lost private token.

## Resident reporting and recovery

1. Capture a photo, enter a caption, and confirm GPS or adjust the map pin. If
   GPS is unavailable, choose and confirm the location on the map. An optional
   address adds context. Retaking the photo clears the previous location and
   requires a fresh GPS lookup or confirmed pin.
2. Submit and wait for backend confirmation. The app first saves a report UUID,
   private token, and immutable photo/upload draft.
3. If interrupted, return to **My reports** and recover using that saved report.
   Timeouts retain the same identity and bytes; they do not create another report.
4. Refresh status to read paginated history and authorized report/cleanup photos.
   A definitively rejected upload can be edited or explicitly discarded after
   checking that the server has not accepted it.

Tokens use SecureStore; photos and draft metadata use native files. Metadata is
published through a completed temporary file before old revisions are removed.
Unreadable records are isolated while their photos and keys remain recoverable;
existing unversioned drafts remain readable. Temporary signed photo URLs remain
in memory, refresh on expiry, and receive no backend authorization header or
persistent image disk cache.

The form does not ask fire/sharp-object questions; omitted answers remain unknown
to the backend. Report photos support JPEG, PNG, and WebP within the API's 8 MiB
and 25-megapixel limits. New reports require coordinates; an address cannot
replace them. Existing accepted address-only reports retain identical-retry
support and need a location clarification before routing.

## Organizer dispatch and crew collection

**Dispatch** reads real crews and active jobs. Select 1–5 crews and 1–25 jobs,
including every unfinished assignment of each selected crew. Mobile exposes
remaining route duration, maximum stops, return-to-start, and partial dispatch
controls. Review estimates, fixed work, reassignments, omissions, and expiry
before approving. Incomplete proposals require explicit partial acknowledgement.
Review holds are resolved through backend policy, never bypassed by the planner.

**My route** reads the signed-in crew's assignments in server order. While
focused and foregrounded, it publishes a fresh crew location initially and every
30 seconds; staff data refreshes every 15 seconds. Backgrounding, leaving the
screen, or signing out stops location publishing. Denied or unavailable GPS is
visible and can be retried.

Start the next stop before completing it. A cleanup photo is optional; completing
without one requires a separate confirmation. Completion is crew-submitted and
has no general crew undo toggle. Saved command IDs and evidence survive native
app restarts and are isolated by account, crew, and API environment. Recover
uncertain outcomes with the saved action; a definite dispatch conflict requires
a new preview. See [mobile routing and completion](../docs/backend/mobile-routing-completion.md).

Separately prepared local demo builds may include **Demo crew location** and
`EXPO_PUBLIC_DEMO_LOCATIONS`. The main app uses foreground GPS; those controls require the separate local
mobile implementation. Follow the
[demo guide](../docs/demo.md#recording-the-worcester-and-karachi-demos) only with a
matching build, and label staged locations explicitly.

## Live data and demo boundaries

- The public map reads `GET /map/markers` while focused and refreshes on return
  to the foreground. Markers use approximately 100 m rounded coordinates for
  committed, non-illustrative reports, including reports awaiting assessment or
  review. Nearby reports share a marker; completed linked work disappears.
- City statistics are hidden from live navigation; their source fixtures and
  remaining static city/crew fixtures are illustrative, not measured impact analytics.
- Route maps show stop order rather than road geometry. Routing needs fresh crew
  locations, the matching API contract, and an enabled road-time provider.
- Assessment needs the separately running worker. The app does not activate
  either that worker or Photon messaging.

## In-app report updates

When the bounded phone integration is configured for a report, its details offer
a **Report updates** composer. Type **Status** and send after reading the disclosure
that a copy goes to the masked registered phone. The backend returns the committed
status snapshot immediately; phone delivery remains a separate receipt state.
The app checks that receipt while foregrounded for up to 90 seconds and offers
manual checking afterward. An uncertain request retains its saved command ID.
This app flow needs no phone-side LINK command and makes no AI request. See
[phone updates](../docs/backend/phone-updates.md) for scope, consent, and recovery.

## Source layout

| Path | Purpose |
| --- | --- |
| `src/app/` | Expo Router screens and layouts. |
| `src/auth/` | Supabase session lifecycle and verified roles. |
| `src/services/` | Resident/staff API clients, secure draft storage, and durable commands. |
| `src/hooks/` | Location, focused data loading, city selection, and request lifecycle. |
| `src/components/` | Reporting, routing, dispatch, map, and shared UI components. |
| `src/data/` | Data adapters and illustrative fixtures. |
| `src/theme/` | Shared colors, typography, spacing, and map style. |
| `tests/` | Node-based client, storage, auth, and UI behavior tests. |

## Checks

Run from `mobile/`:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run audit:ci
```

Tests use controlled platform/provider substitutes. Real camera, foreground GPS,
account switching, interrupted submissions, and both completion choices still
need device acceptance. Do not run `reset-project` on the finished application;
it is a leftover starter utility, not a normal development step.

See [backend setup](../docs/backend/setup.md), the
[mobile API handoff](../docs/backend/mobile-handoff.md), and the
[documentation index](../docs/README.md) for server setup and detailed contracts.
