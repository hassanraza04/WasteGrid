# Organiser Routing Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give authenticated organisers a safe web workspace to preview and separately confirm an explicitly scoped route dispatch.

**Architecture:** Extend `OrganizerApi` with typed routing resources while retaining its bearer-authentication and session-version guard. Add a focused `/admin/dispatch` component that owns selection, preview, confirmation, and stale-request guards. It fails closed when the deployed server lacks Omer's scoped routing contract.

**Tech Stack:** React 19, React Router, TypeScript, Vitest, React Testing Library.

## Global Constraints

- Reuse existing organiser login, `AccessError`, bearer request, session-version, and unmount guards.
- Read every `/jobs` page with `active_only=true`, `limit=100`, and increasing `offset`.
- Send explicit 1 to 5 crew IDs and 1 to 25 job IDs for every preview. Never retry a 422 without `job_ids`.
- Invalidate preview on any scope change and compare returned canonical job IDs with the requested set.
- Dispatch only a dispatchable, unexpired, undispatched preview with nonempty stops after a separate confirmation.
- Reuse frozen preview ID and command UUID only after an uncertain result. A 409 requires fresh state and recomputation.
- No workers, messaging, fixture resets, or live dispatch. Preserve review hold `WG-8D724DBFF0D8`.

---

### Task 1: Typed routing API ✅

**Files:**
- Modify: `web/src/live/organizerApi.ts`
- Test: `web/src/live/organizerApi.test.ts`

**Interfaces:**
- Produces `OrganizerCrew`, `OrganizerRoutingJob`, `OrganizerCurrentPlan`, `OrganizerRoutePreview`, and typed routing methods from the interface specification.

- [ ] **Step 1: Write failing API tests**

```ts
test("loads every active-job page and sends an explicit scoped preview", async () => {
  // Mock two 100-item pages and a final short page.
  // Assert each encoded query and the exact `{ crew_ids, job_ids }` JSON body.
});

test("classifies scoped preview incompatibility and dispatch conflict safely", async () => {
  // Assert 422 becomes RoutingContractError and 409 becomes RoutingConflictError.
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- organizerApi.test.ts`

Expected: FAIL because the routing methods and error types do not exist.

- [ ] **Step 3: Implement only the typed API and safe request classification**

```ts
previewRouting(crewIds: string[], jobIds: string[]): Promise<OrganizerRoutePreview>;
dispatchRouting(previewId: string, commandId: string): Promise<OrganizerDispatchResult>;
```

The jobs method advances the offset by the page length and stops only after a short page.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- organizerApi.test.ts`

Expected: PASS.

### Task 2: Dispatch workspace selection and preview

**Files:**
- Create: `web/src/live/OrganizerDispatchWorkspace.tsx`
- Modify: `web/src/live/OrganizerDashboard.tsx`
- Test: `web/src/live/OrganizerDispatchWorkspace.test.tsx`

**Interfaces:**
- Consumes the Task 1 API methods and `AccessError`.
- Produces an authenticated `/admin/dispatch` route and no backend mutation until confirmed dispatch.

- [ ] **Step 1: Write failing component tests**

```tsx
test("requires explicit crew and job selection then rejects a mismatched canonical scope", async () => {
  // Load state, select a crew and job, compute, and assert dispatch is absent on mismatched `job_ids`.
});

test("clears a preview when the scope changes", async () => {
  // Compute a valid preview, alter selection, and assert confirmation is disabled.
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- OrganizerDispatchWorkspace.test.tsx`

Expected: FAIL because the component and route do not exist.

- [ ] **Step 3: Implement the smallest selection, state-load, preview, and review UI**

The component labels illustrative data, shows GPS freshness and assigned/fixed work, lists route stops and route metadata, and includes OSRM/OpenStreetMap attribution.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- OrganizerDispatchWorkspace.test.tsx`

Expected: PASS.

### Task 3: Separate confirmation and conflict behavior

**Files:**
- Modify: `web/src/live/OrganizerDispatchWorkspace.tsx`
- Test: `web/src/live/OrganizerDispatchWorkspace.test.tsx`

**Interfaces:**
- Consumes `dispatchRouting(previewId, commandId)`.
- Produces an in-memory frozen command identity and safe 409 handling.

- [ ] **Step 1: Write failing confirmation tests**

```tsx
test("freezes one command ID for an uncertain dispatch retry", async () => {
  // Make first dispatch reject as network failure, retry, and assert the same preview/UUID pair.
});

test("a dispatch conflict refreshes state and requires a new preview", async () => {
  // Return RoutingConflictError, assert preview disappears, selection persists, and a second dispatch is impossible.
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- OrganizerDispatchWorkspace.test.tsx`

Expected: FAIL because confirmation is not implemented.

- [ ] **Step 3: Implement confirmation and conflict recovery**

Display a confirmation button before POST. Capture `preview.id` and `crypto.randomUUID()` once. On `RoutingConflictError`, clear the frozen command and preview, reload state, retain selection, and show a safe fresh-preview message.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- OrganizerDispatchWorkspace.test.tsx`

Expected: PASS.

### Task 4: Full verification

**Files:**
- Modify if required by test failures only.

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 2: Run all web tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 3: Run production build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 4: Review and commit**

Run: `git diff --check && git status --short`

Expected: clean whitespace check and only routing-workspace changes before the commit.

## Self-review

- Spec coverage: Task 1 covers typed, paginated reads and scoped requests. Task 2 covers explicit selection, labels, preview output, canonical scope validation, and stale-request guards. Task 3 covers separate confirmation, frozen identity, uncertain retries, and definitive 409 behavior. Task 4 covers typecheck, tests, build, and review.
- Placeholder scan: no deferred requirements or generic testing steps remain.
- Type consistency: all component calls consume the typed `OrganizerApi` methods defined in the interface document.
