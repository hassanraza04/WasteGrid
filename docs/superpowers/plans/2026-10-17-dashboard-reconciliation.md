# Dashboard Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework PR #15 into a compatible follow-up that preserves PR #13's hosted organizer dashboard while restoring the existing browser-local customer routes.

**Architecture:** `LiveApp` remains the only dashboard composition root and reuses the current hosted organizer API. It will also compose the existing customer route components behind the public paths. The legacy local organizer files and the duplicate PR #15 Supabase implementation are removed.

**Tech Stack:** React 19, React Router 7, TypeScript, Vite, Vitest, React Testing Library, Supabase browser SDK.

## Global Constraints

- Keep one hosted organizer dashboard, one Supabase browser client, and one organizer API adapter.
- Keep the browser organizer session in memory with `persistSession: false`.
- Preserve PR #13 pagination, photo access, request timeout, and 401/403 access handling.
- Customer routes remain browser-local demos and must not call the hosted API.
- A missing or malformed public dashboard configuration must render an organizer configuration error without breaking public routes.
- Run the web coverage command. The configured branch, function, line, and statement thresholds are 90%.

---

### Task 1: Rebase the PR branch and remove superseded organizer code

**Files:**
- Modify: `web/src/live/LiveApp.tsx`
- Delete: `web/src/admin/AdminDashboardPage.tsx`
- Delete: `web/src/admin/AdminSignInPage.tsx`
- Delete: `web/src/admin/RequireAdmin.tsx`
- Delete: `web/src/admin/adminRoutes.test.tsx`
- Delete: `web/src/auth/adminSession.ts`
- Delete: `web/src/auth/browserAdminSession.ts`
- Delete: `web/src/auth/browserAdminSession.test.ts`
- Delete: `web/src/auth/organizerSession.ts`
- Delete: `web/src/auth/organizerSession.test.ts`
- Delete: `web/src/config/hostedDashboard.ts`
- Delete: `web/src/config/hostedDashboard.test.ts`
- Delete: `web/src/data/organizerApi.ts`
- Delete: `web/src/data/organizerApi.test.ts`

**Interfaces:**
- Consumes: `origin/main` commit containing PR #13's `LiveApp` and `OrganizerApi`.
- Produces: A branch based on current main with no duplicate organizer modules or imports.

- [ ] **Step 1: Rebase the isolated branch on current main**

Run:

```bash
git fetch origin main
git rebase origin/main
```

Resolve `web/src/main.tsx`, `web/package.json`, and `web/package-lock.json` by retaining main's PR #13 versions. Resolve documentation conflicts by retaining the reconciliation design and current shared-API facts.

- [ ] **Step 2: Verify the rebased baseline**

Run:

```bash
git status --short --branch
npm run test
npm run typecheck
```

Expected: the branch is based on `origin/main`; existing web tests and type checking pass before source edits.

- [ ] **Step 3: Delete duplicate organizer files**

Remove the listed PR #15 modules and tests. Do not delete `web/src/live/LiveApp.tsx` or `web/src/live/organizerApi.ts` from main.

- [ ] **Step 4: Verify that one dashboard implementation remains**

Run:

```bash
rg -n 'HostedOrganizerApi|SupabaseOrganizerSession|RequireAdmin|AdminDashboardPage|AdminSignInPage' web/src
```

Expected: no output. `web/src/live/LiveApp.tsx` and `web/src/live/organizerApi.ts` remain the sole organizer implementation.

- [ ] **Step 5: Commit the reconciliation cleanup**

```bash
git add -A web/src
git commit -m "Remove duplicate organizer dashboard"
```

### Task 2: Restore public customer routes through `LiveApp`

**Files:**
- Modify: `web/src/live/LiveApp.tsx`
- Modify: `web/src/live/LiveApp.test.tsx`
- Delete: `web/src/app/App.tsx`
- Delete: `web/src/app/App.test.tsx`
- Delete: `web/src/app/App.error.test.tsx`
- Modify: `web/src/customer/customerRoutes.test.tsx`

**Interfaces:**
- Consumes: `BrowserReportRepository` from `web/src/data/browserReportRepository.ts` and the existing customer route components.
- Produces: `LiveApp` routes `/`, `/report/new`, `/report/track`, `/report/:reference`, and `/admin/*`.

- [ ] **Step 1: Write the failing public-route integration test**

In `web/src/live/LiveApp.test.tsx`, add a test using `MemoryRouter` and the existing supplied organizer API:

```tsx
test("keeps customer report routes available beside the hosted dashboard", async () => {
  const { user } = setup("/report/new");

  await user.type(screen.getByLabelText("What needs attention?"), "Overflowing bin");
  await user.type(screen.getByLabelText("Address"), "14 Market Street");
  await user.click(screen.getByRole("button", { name: "Create report" }));

  expect(await screen.findByRole("heading", { name: /Report WG-/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test -- src/live/LiveApp.test.tsx
```

Expected: FAIL because PR #13 currently sends `/report/new` to the fallback route.

- [ ] **Step 3: Compose the public routes in `LiveApp`**

Import `CreateReportPage`, `CustomerHomePage`, `ReportDetailPage`, `TrackReportPage`, `BrowserReportRepository`, `ReportErrorBoundary`, and `ReportRepository`. Add a module-level browser repository:

```tsx
const defaultRepository = new BrowserReportRepository(window.localStorage);
```

Expand `LiveApp` properties with `repository?: ReportRepository`, default it to `defaultRepository`, and replace the current home and fallback routes with:

```tsx
function OrganizerConfigurationPage() {
  return <main><h1>Organiser sign in</h1><p role="alert">Organiser sign-in has not been configured for this build.</p></main>;
}

<ReportErrorBoundary>
  <Routes>
    <Route path="/" element={<CustomerHomePage repository={repository} />} />
    <Route path="/report/new" element={<CreateReportPage repository={repository} />} />
    <Route path="/report/track" element={<TrackReportPage />} />
    <Route path="/report/:reference" element={<ReportDetailPage repository={repository} />} />
    <Route path="/admin/*" element={api ? <Dashboard api={api} /> : <OrganizerConfigurationPage />} />
    <Route path="*" element={<main><h1>Page not found</h1><Link to="/">Home</Link></main>} />
  </Routes>
</ReportErrorBoundary>
```

Keep the existing `Dashboard`, paging, photo, and logout code unchanged.

- [ ] **Step 4: Run the focused route tests to verify they pass**

Run:

```bash
npm run test -- src/live/LiveApp.test.tsx src/customer/customerRoutes.test.tsx
```

Expected: PASS. `/report/new` creates a local demo report and `/admin` still requires organizer sign-in.

- [ ] **Step 5: Remove the unused old composition root and update customer tests**

Delete `App.tsx` and its two app-level test files. Update `customerRoutes.test.tsx` so its render helper uses `LiveApp` with the supplied `repository`, rather than `App`.

- [ ] **Step 6: Commit the route composition change**

```bash
git add web/src/live/LiveApp.tsx web/src/live/LiveApp.test.tsx web/src/customer/customerRoutes.test.tsx web/src/app
git commit -m "Restore public routes beside hosted dashboard"
```

### Task 3: Make malformed organizer configuration a named, tested fallback

**Files:**
- Modify: `web/src/live/organizerApi.ts`
- Modify: `web/src/live/LiveApp.tsx`
- Modify: `web/src/live/LiveApp.test.tsx`

**Interfaces:**
- Consumes: Vite's three public environment variables.
- Produces: `DashboardConfigurationError` and a route-specific configuration message.

- [ ] **Step 1: Write the failing malformed-configuration test**

In `web/src/live/LiveApp.test.tsx`, stub a valid API URL and publishable key with an invalid Supabase URL. Render `/admin` without the supplied API and assert:

```tsx
expect(screen.getByRole("alert")).toHaveTextContent("VITE_SUPABASE_URL must be a valid HTTPS URL");
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run test -- src/live/LiveApp.test.tsx
```

Expected: FAIL because the current generic configuration fallback does not identify malformed `VITE_SUPABASE_URL`.

- [ ] **Step 3: Add minimal validation and preserve public routes**

In `organizerApi.ts`, export:

```ts
export class DashboardConfigurationError extends Error {}
```

Validate each configured URL with `new URL(value)`, require `https:` for the Supabase URL and `http:` or `https:` for the API URL, then throw `DashboardConfigurationError` with the exact setting-specific message. Replace the Task 2 `OrganizerConfigurationPage` with:

```tsx
function OrganizerConfigurationPage({ message }: { message: string }) {
  return <main><h1>Organiser sign in</h1><p role="alert">{message}</p></main>;
}
```

In `LiveApp`, initialize the organizer dependency once and retain a caught configuration message:

```tsx
const [dashboard] = useState(() => {
  if (suppliedApi) return { api: suppliedApi, configurationError: "" };
  try {
    return { api: createOrganizerApi(), configurationError: "" };
  } catch (caught) {
    return {
      api: null,
      configurationError: caught instanceof Error
        ? caught.message
        : "Organiser sign-in has not been configured for this build.",
    };
  }
});
```

Use `dashboard.api` for `/admin/*` and pass `dashboard.configurationError` to `OrganizerConfigurationPage`. The public routes must not read this state or throw from render.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
npm run test -- src/live/LiveApp.test.tsx src/live/organizerApi.test.ts
```

Expected: PASS. A malformed setting produces the named error and valid hosted API tests still pass.

- [ ] **Step 5: Commit the configuration behavior**

```bash
git add web/src/live/organizerApi.ts web/src/live/organizerApi.test.ts web/src/live/LiveApp.tsx web/src/live/LiveApp.test.tsx
git commit -m "Handle malformed organizer configuration"
```

### Task 4: Reconcile documentation and run the full verification suite

**Files:**
- Modify: `docs/backend/dashboard-handoff.md`
- Modify: `web/README.md`
- Modify: `docs/superpowers/specs/2026-10-17-hosted-organizer-dashboard-design.md`

**Interfaces:**
- Consumes: the merged shared API URL and browser origin agreement.
- Produces: documentation that describes one hosted organizer dashboard and browser-local public demo routes.

- [ ] **Step 1: Remove stale PR #15 dashboard claims**

Document the shared API `https://wastegrid-api-dev.onrender.com`, the browser origin `http://127.0.0.1:5173`, the three public Vite variables, and the fact that `/admin` is the only hosted organizer flow. Do not claim Photon activation, AI-worker activity, or a local API URL as the dashboard target.

- [ ] **Step 2: Verify no duplicate implementation or stale route references remain**

Run:

```bash
rg -n 'HostedOrganizerApi|SupabaseOrganizerSession|RequireAdmin|AdminDashboardPage|AdminSignInPage|browserAdminSession' web docs
git diff --check origin/main...HEAD
```

Expected: no duplicate source implementation references and no whitespace errors.

- [ ] **Step 3: Run the full web verification suite**

Run:

```bash
npm run test
npm run coverage
npm run typecheck
npm run build
```

Expected: all tests pass, coverage meets every 90% threshold, type checking passes, and the production build succeeds.

- [ ] **Step 4: Commit verification-ready documentation**

```bash
git add docs/backend/dashboard-handoff.md web/README.md docs/superpowers/specs/2026-10-17-hosted-organizer-dashboard-design.md
git commit -m "Document reconciled organizer dashboard"
```
