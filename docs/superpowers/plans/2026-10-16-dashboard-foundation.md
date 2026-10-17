# Dashboard Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone React and TypeScript dashboard foundation with public customer report flows and a locally protected organizer route.

**Architecture:** The `web/` Vite application owns routes and presentation. Its components use a `ReportRepository` interface and an `AdminSession` interface, while browser-local adapters provide demo report persistence and development-only organizer sign-in. Replacing the adapters later must not require route-component changes.

**Tech Stack:** React 19, TypeScript, Vite, React Router, Vitest, React Testing Library, browser local storage.

## Global Constraints

- Put all frontend code in `web/`; do not alter the Photon messaging modules.
- Keep public customer routes sign-in free.
- Require an `AdminSession` before rendering `/admin`.
- Persist created and selected demo reports only through `ReportRepository`.
- Keep styling semantic and minimal until the approved Figma design is available.
- Use strict TypeScript and test behavior with Vitest and React Testing Library.

---

### Task 1: Create the standalone frontend and test harness

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/tsconfig.app.json`
- Create: `web/index.html`
- Create: `web/src/main.tsx`
- Create: `web/src/app/App.tsx`
- Create: `web/src/test/setup.ts`
- Create: `web/src/app/App.test.tsx`

**Interfaces:**
- Produces `App`, rendered by `main.tsx`.
- Produces `npm run test`, `npm run typecheck`, and `npm run build` commands for later tasks.

- [ ] **Step 1: Create the package manifest and TypeScript configuration**

```json
{
  "name": "wastegrid-web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "react": "latest",
    "react-dom": "latest",
    "react-router-dom": "latest",
    "vite": "latest"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "jsdom": "latest",
    "typescript": "latest",
    "vitest": "latest"
  }
}
```

- [ ] **Step 2: Write the failing app smoke test**

```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "./App";

test("renders the public WasteGrid entry point", () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  expect(screen.getByRole("heading", { name: "WasteGrid" })).toBeInTheDocument();
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd web && npm run test -- src/app/App.test.tsx`

Expected: FAIL because the frontend package and `App` module do not exist.

- [ ] **Step 4: Implement the smallest app shell**

```tsx
export function App() {
  return (
    <main>
      <h1>WasteGrid</h1>
    </main>
  );
}
```

Configure Vitest with `environment: "jsdom"`, load `@testing-library/jest-dom/vitest` in `src/test/setup.ts`, and render `App` from `src/main.tsx` using `StrictMode`.

- [ ] **Step 5: Run the smoke test and type check**

Run: `cd web && npm run test -- src/app/App.test.tsx && npm run typecheck`

Expected: PASS and zero TypeScript errors.

- [ ] **Step 6: Commit the frontend harness**

```bash
git add web
git commit -m "Add dashboard frontend harness"
```

### Task 2: Add report domain types and local fixture repository

**Files:**
- Create: `web/src/domain/reports.ts`
- Create: `web/src/data/reportRepository.ts`
- Create: `web/src/data/browserReportRepository.ts`
- Create: `web/src/data/browserReportRepository.test.ts`

**Interfaces:**
- Produces `Report`, `ReportUpdate`, `ConversationMessage`, `ReportLocation`, and `CreateReportInput`.
- Produces `ReportRepository` with `getByReference(reference)`, `create(input)`, and `getRememberedReference()` methods.
- Later route components consume only `ReportRepository`.

- [ ] **Step 1: Write failing repository tests**

```ts
test("creates a report and makes it retrievable by its generated reference", () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const report = repository.create({ title: "Overflowing bin", address: "14 Market Street" });

  expect(report.reference).toMatch(/^WG-/);
  expect(repository.getByReference(report.reference)).toEqual(report);
});

test("remembers a selected report across repository instances", () => {
  const first = new BrowserReportRepository(window.localStorage);
  const report = first.create({ title: "Fly tipping", address: "Central Park" });
  first.remember(report.reference);

  const second = new BrowserReportRepository(window.localStorage);
  expect(second.getRememberedReference()).toBe(report.reference);
});
```

- [ ] **Step 2: Run the repository tests to verify they fail**

Run: `cd web && npm run test -- src/data/browserReportRepository.test.ts`

Expected: FAIL because the repository and domain modules do not exist.

- [ ] **Step 3: Define the domain and repository contract**

```ts
export interface ReportRepository {
  list(): Report[];
  getByReference(reference: string): Report | undefined;
  create(input: CreateReportInput): Report;
  remember(reference: string): void;
  getRememberedReference(): string | undefined;
}
```

Store reports under `wastegrid.demo.reports` and the selected reference under `wastegrid.demo.last-report`. Seed one realistic report only when no stored reports exist. Generate references with `WG-` plus an uppercase base-36 timestamp and random suffix. Reject blank title and address inputs with an `Error` whose message can be rendered by the form.

- [ ] **Step 4: Run the repository tests**

Run: `cd web && npm run test -- src/data/browserReportRepository.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the domain layer**

```bash
git add web/src/domain web/src/data
git commit -m "Add local report repository"
```

### Task 3: Add the local admin-session boundary

**Files:**
- Create: `web/src/auth/adminSession.ts`
- Create: `web/src/auth/browserAdminSession.ts`
- Create: `web/src/auth/browserAdminSession.test.ts`

**Interfaces:**
- Produces `AdminSession` with `isSignedIn()`, `signIn()`, and `signOut()`.
- Produces `BrowserAdminSession`, which stores only a development boolean in local storage.

- [ ] **Step 1: Write failing session tests**

```ts
test("starts signed out and remains signed in after a new instance is created", () => {
  const first = new BrowserAdminSession(window.localStorage);
  expect(first.isSignedIn()).toBe(false);

  first.signIn();

  const second = new BrowserAdminSession(window.localStorage);
  expect(second.isSignedIn()).toBe(true);
});
```

- [ ] **Step 2: Run the session test to verify it fails**

Run: `cd web && npm run test -- src/auth/browserAdminSession.test.ts`

Expected: FAIL because the session modules do not exist.

- [ ] **Step 3: Implement the session adapter**

```ts
export interface AdminSession {
  isSignedIn(): boolean;
  signIn(): void;
  signOut(): void;
}
```

Use the storage key `wastegrid.demo.admin-session` and store the literal string `"signed-in"`. `signOut()` removes the key.

- [ ] **Step 4: Run the session test**

Run: `cd web && npm run test -- src/auth/browserAdminSession.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the session boundary**

```bash
git add web/src/auth
git commit -m "Add local admin session adapter"
```

### Task 4: Implement public customer report routes

**Files:**
- Create: `web/src/customer/CustomerHomePage.tsx`
- Create: `web/src/customer/CreateReportPage.tsx`
- Create: `web/src/customer/TrackReportPage.tsx`
- Create: `web/src/customer/ReportDetailPage.tsx`
- Create: `web/src/customer/customerRoutes.test.tsx`
- Modify: `web/src/app/App.tsx`

**Interfaces:**
- Consumes `ReportRepository`.
- Produces public routes `/`, `/report/new`, `/report/track`, and `/report/:reference`.

- [ ] **Step 1: Write failing route tests**

```tsx
test("restores the remembered report from the public home route", () => {
  repository.remember("WG-DEMO");
  renderAppAt("/", repository);
  expect(screen.getByRole("heading", { name: /WG-DEMO/i })).toBeInTheDocument();
});

test("creates a report and navigates to its detail page", async () => {
  const user = userEvent.setup();
  renderAppAt("/report/new", repository);
  await user.type(screen.getByLabelText("What needs attention?"), "Overflowing bin");
  await user.type(screen.getByLabelText("Address"), "14 Market Street");
  await user.click(screen.getByRole("button", { name: "Create report" }));

  expect(await screen.findByText("Overflowing bin")).toBeInTheDocument();
});

test("shows a clear not-found state for an unknown report", () => {
  renderAppAt("/report/UNKNOWN", repository);
  expect(screen.getByRole("heading", { name: "Report not found" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the customer route tests to verify they fail**

Run: `cd web && npm run test -- src/customer/customerRoutes.test.tsx`

Expected: FAIL because the customer pages and routes do not exist.

- [ ] **Step 3: Implement customer behavior**

Use React Router route parameters and `useNavigate`. `CustomerHomePage` redirects to `/report/:reference` when `getRememberedReference()` returns a stored reference that exists. `TrackReportPage` trims the entered reference and navigates to `/report/:reference`. `ReportDetailPage` calls `repository.remember(reference)` only after resolving a report. Render semantic headings, labels, buttons, and text content without final design styling.

Update `App` to accept dependencies for testability:

```ts
export interface AppDependencies {
  repository?: ReportRepository;
  adminSession?: AdminSession;
}
```

When omitted, instantiate `BrowserReportRepository(window.localStorage)` and
`BrowserAdminSession(window.localStorage)` once in `main.tsx` and pass them to
`App`. Customer route tests pass a fresh repository instance through `App`.

- [ ] **Step 4: Run the customer route tests**

Run: `cd web && npm run test -- src/customer/customerRoutes.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the customer routes**

```bash
git add web/src/app web/src/customer
git commit -m "Add public customer report routes"
```

### Task 5: Implement protected organizer routes

**Files:**
- Create: `web/src/admin/RequireAdmin.tsx`
- Create: `web/src/admin/AdminSignInPage.tsx`
- Create: `web/src/admin/AdminDashboardPage.tsx`
- Create: `web/src/admin/adminRoutes.test.tsx`
- Modify: `web/src/app/App.tsx`

**Interfaces:**
- Consumes `AdminSession` and `ReportRepository`.
- Produces `/admin/sign-in` and `/admin`.

- [ ] **Step 1: Write failing admin route tests**

```tsx
test("redirects an unsigned-in organizer to sign-in", () => {
  renderAppAt("/admin", repository, signedOutSession);
  expect(screen.getByRole("heading", { name: "Organizer sign in" })).toBeInTheDocument();
});

test("renders the organizer dashboard after the local sign-in action", async () => {
  const user = userEvent.setup();
  renderAppAt("/admin/sign-in", repository, signedOutSession);
  await user.click(screen.getByRole("button", { name: "Continue as organizer" }));

  expect(await screen.findByRole("heading", { name: "Organizer dashboard" })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the admin route tests to verify they fail**

Run: `cd web && npm run test -- src/admin/adminRoutes.test.tsx`

Expected: FAIL because the admin route components do not exist.

- [ ] **Step 3: Implement the protected route and dashboard**

`RequireAdmin` must return `<Navigate to="/admin/sign-in" replace />` when `session.isSignedIn()` is false. `AdminSignInPage` calls `session.signIn()` and navigates to `/admin`. `AdminDashboardPage` shows a semantic heading and the fixture report references through repository data. Include a sign-out button that calls `session.signOut()` and navigates to `/admin/sign-in`.

- [ ] **Step 4: Run the admin route tests**

Run: `cd web && npm run test -- src/admin/adminRoutes.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit the organizer routes**

```bash
git add web/src/admin web/src/app/App.tsx
git commit -m "Add protected organizer routes"
```

### Task 6: Document and verify the frontend foundation

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-16-dashboard-foundation-design.md`

**Interfaces:**
- Documents `npm install`, `npm run dev`, `npm run test`, and the development-only nature of the local admin session.

- [ ] **Step 1: Add frontend run instructions to the README**

```markdown
## Dashboard foundation

```bash
cd web
npm install
npm run dev
```

Open the public customer view at the local Vite URL. Open `/admin` to use the
development-only organizer sign-in. Its browser-local session is not production
authentication.
```

- [ ] **Step 2: Run the complete frontend verification**

Run: `cd web && npm run test && npm run typecheck && npm run build`

Expected: all tests pass, TypeScript reports zero errors, and Vite completes a production build.

- [ ] **Step 3: Run the existing Python regression suite**

Run: `uv run pytest -q && uv run mypy --strict api/messaging`

Expected: 19 passing Python tests and zero mypy errors.

- [ ] **Step 4: Commit the documentation and final verification changes**

```bash
git add README.md docs/superpowers/specs/2026-10-16-dashboard-foundation-design.md web
git commit -m "Document dashboard foundation"
```

## Plan self-review

- Spec coverage: Tasks 1 through 5 cover the standalone application, typed adapters, customer routes, local report persistence, and protected organizer routes. Task 6 covers documentation and full verification.
- Scope: The plan excludes production authentication, API integration, Photon, Chalk, maps, and Figma-specific styling as required.
- Type consistency: `ReportRepository` and `AdminSession` are introduced before route components consume them.
- Placeholder scan: No deferred implementation steps are used; every task names the files, APIs, tests, commands, and expected outcomes.
