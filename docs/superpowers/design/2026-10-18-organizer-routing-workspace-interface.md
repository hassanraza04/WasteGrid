# Organiser Routing Workspace Interface Specification

## Public API additions

```ts
export interface OrganizerCrew {
  id: string;
  name: string;
  available: boolean;
  location_recorded_at: string | null;
  illustrative: boolean;
}

export interface OrganizerRoutingJob {
  id: string;
  status: "unassigned" | "assigned" | "in_progress" | "blocked" | "completed" | "recheck_requested";
  category: string;
  priority: Priority;
  assigned_crew_id: string | null;
  locked: boolean;
  held: boolean;
  estimated_service_minutes: number;
  illustrative: boolean;
}

export interface OrganizerPlanAssignment {
  crew_id: string;
  job_id: string;
  position: number;
  travel_minutes: number;
  service_minutes: number;
}

export interface OrganizerCurrentPlan {
  plan: { id: string; assignments: OrganizerPlanAssignment[] } | null;
}

export interface OrganizerRouteStop {
  job_id: string;
  position: number;
  travel_minutes: number;
  service_minutes: number;
  completion_minutes: number;
  priority: Priority;
  fixed: boolean;
}

export interface OrganizerRoutePreview {
  id: string;
  job_ids: string[];
  routes: Array<{ crew_id: string; duration_minutes: number; travel_minutes: number; stops: OrganizerRouteStop[] }>;
  exclusions: Array<{ job_id: string; reason: string }>;
  unassigned: Array<{ job_id: string; reason: string }>;
  reassignments: Array<{ job_id: string; previous_crew_id: string | null; proposed_crew_id: string; proposed_position: number }>;
  dispatchable: boolean;
  expires_at: string;
  plan_id: string | null;
}

export interface OrganizerDispatchResult {
  plan_id: string;
}

export class OrganizerApi {
  crews(): Promise<OrganizerCrew[]>;
  jobs(): Promise<OrganizerRoutingJob[]>;
  currentPlan(): Promise<OrganizerCurrentPlan>;
  previewRouting(crewIds: string[], jobIds: string[]): Promise<OrganizerRoutePreview>;
  dispatchRouting(previewId: string, commandId: string): Promise<OrganizerDispatchResult>;
}
```

## Component contract

```ts
export function OrganizerDispatchWorkspace(props: {
  api: OrganizerApi;
  onSessionExpired: (error: AccessError) => void;
}): JSX.Element;
```

The component owns selected crew IDs, selected job IDs, loaded routing state, one preview, one frozen dispatch command ID, error/loading state, a request generation, and mounted state.

## Invariants

- Every preview request carries distinct `crew_ids` and distinct `job_ids`.
- A UI selection change clears both preview and frozen command ID before another dispatch can occur.
- A preview is dispatchable only when the returned job ID set exactly equals the requested job ID set, `dispatchable` is true, `plan_id` is null, expiry is future, and at least one route has a stop.
- The confirmation UI freezes the preview ID and command UUID. An uncertain retry reuses both values.
- A definite 409 never retries the old preview. It clears preview/command, retains selection, reloads state, and asks for recomputation.
- Async callbacks may update state only when mounted, request generation, and `api.sessionVersion` still match their captured values.

## Error categories

```ts
export class AccessError extends Error {}
export class RoutingContractError extends Error {}
export class RoutingConflictError extends Error {}
```

`AccessError` remains the existing authenticated-session error. `RoutingContractError` identifies missing scoped backend support or a mismatched canonical response. `RoutingConflictError` represents a definite 409 only.

## Non-goals

This workspace does not deploy the backend, start a worker or message poller, reset fixtures, conduct live dispatch, bypass held or review-required jobs, or provide route navigation. It does not add durable browser storage for commands; an uncertain retry remains available only during the active review session.
