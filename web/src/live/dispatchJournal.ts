import type { OrganizerRoutePreview } from "./organizerApi";
import type { RoutingConstraints } from "./organizerTypes";

export const DEFAULT_CONSTRAINTS: RoutingConstraints = {
  max_duration_minutes: 120,
  max_stops_per_crew: 10,
  return_to_start: true,
  allow_partial: false,
};
export interface DispatchJournal {
  version: 1;
  crewIds: string[];
  jobIds: string[];
  constraints: RoutingConstraints;
  previewId: string | null;
  commandId: string | null;
  acceptPartial: boolean;
  stage: "selection" | "reviewed" | "attempted" | "committed" | "conflict";
}
export function emptyJournal(): DispatchJournal {
  return {
    version: 1,
    crewIds: [],
    jobIds: [],
    constraints: { ...DEFAULT_CONSTRAINTS },
    previewId: null,
    commandId: null,
    acceptPartial: false,
    stage: "selection",
  };
}
export class JournalUnavailable extends Error {
  constructor(
    message = "Browser storage is unavailable. Dispatch is blocked until durable storage works. Keep this tab open and retry.",
  ) {
    super(message);
  }
}
function partition(environment: string, userId: string): string {
  if (!environment || !userId) throw new JournalUnavailable();
  return `${environment.replace(/\/$/, "")}|${userId}`;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new JournalUnavailable());
      return;
    }
    const request = indexedDB.open("wastegrid-organizer-journal", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("dispatch");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () =>
      reject(new JournalUnavailable());
  });
}
function validEntry(value: DispatchJournal): boolean {
  const ids = (items: unknown, limit: number) =>
    Array.isArray(items) &&
    items.length <= limit &&
    items.every((id) => typeof id === "string" && id.length > 0) &&
    new Set(items).size === items.length;
  const controls = value.constraints;
  const constraintsValid =
    controls &&
    (controls.max_duration_minutes === null ||
      (Number.isFinite(controls.max_duration_minutes) &&
        controls.max_duration_minutes > 0 &&
        controls.max_duration_minutes <= 480)) &&
    Number.isInteger(controls.max_stops_per_crew) &&
    controls.max_stops_per_crew >= 1 &&
    controls.max_stops_per_crew <= 25 &&
    typeof controls.return_to_start === "boolean" &&
    typeof controls.allow_partial === "boolean";
  return (
    value.version === 1 &&
    ids(value.crewIds, 5) &&
    ids(value.jobIds, 25) &&
    !!constraintsValid &&
    typeof value.acceptPartial === "boolean" &&
    (!value.acceptPartial || controls.allow_partial) &&
    ["selection", "reviewed", "attempted", "committed", "conflict"].includes(
      value.stage,
    ) &&
    (!["reviewed", "attempted", "committed"].includes(value.stage) ||
      (typeof value.previewId === "string" &&
        value.previewId.length > 0 &&
        typeof value.commandId === "string" &&
        value.commandId.length > 0 &&
        value.crewIds.length > 0 &&
        value.jobIds.length > 0))
  );
}
export async function readJournal(
  environment: string,
  userId: string,
): Promise<DispatchJournal | null> {
  const key = partition(environment, userId);
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("dispatch", "readonly");
    const request = transaction.objectStore("dispatch").get(key);
    let value: DispatchJournal | null = null;
    request.onsuccess = () => {
      value = request.result ?? null;
    };
    transaction.oncomplete = () => {
      db.close();
      if (value !== null && !validEntry(value)) {
        reject(new JournalUnavailable());
        return;
      }
      resolve(value);
    };
    transaction.onerror = transaction.onabort = () => {
      db.close();
      reject(new JournalUnavailable());
    };
  });
}
export async function writeJournal(
  environment: string,
  userId: string,
  entry: DispatchJournal,
): Promise<void> {
  const key = partition(environment, userId);
  const next = structuredClone(entry);
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("dispatch", "readwrite", {
      durability: "strict",
    });
    const store = transaction.objectStore("dispatch");
    const existing = store.get(key);
    let conflict: JournalUnavailable | null = null;
    existing.onsuccess = () => {
      const prior = existing.result as DispatchJournal | undefined;
      if (prior?.stage === "attempted") {
        const keys: Array<keyof RoutingConstraints> = [
          "max_duration_minutes",
          "max_stops_per_crew",
          "return_to_start",
          "allow_partial",
        ];
        const same =
          validEntry(next) &&
          prior.commandId === next.commandId &&
          prior.previewId === next.previewId &&
          prior.acceptPartial === next.acceptPartial &&
          JSON.stringify(prior.crewIds) === JSON.stringify(next.crewIds) &&
          JSON.stringify(prior.jobIds) === JSON.stringify(next.jobIds) &&
          keys.every(
            (key) => prior.constraints?.[key] === next.constraints[key],
          );
        if (
          !same ||
          !["attempted", "committed", "conflict"].includes(next.stage)
        ) {
          conflict = new JournalUnavailable(
            "Another tab has an unconfirmed dispatch. Refresh this page to recover its original command before changing scope.",
          );
          transaction.abort();
          return;
        }
      }
      store.put(next, key);
    };
    // Request success precedes transaction commit. Only oncomplete opens the POST barrier.
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = transaction.onabort = () => {
      db.close();
      reject(conflict ?? new JournalUnavailable());
    };
  });
}
export function sameScope(
  preview: OrganizerRoutePreview,
  entry: DispatchJournal,
): boolean {
  if (
    !Array.isArray(preview.job_ids) ||
    !Array.isArray(preview.routes) ||
    !Array.isArray(preview.unassigned) ||
    !Array.isArray(preview.exclusions) ||
    !Array.isArray(preview.reassignments)
  )
    return false;
  if (
    !preview.metrics ||
    ![
      preview.metrics.weighted_wait,
      preview.metrics.latest_finish,
      preview.metrics.total_travel,
      preview.metrics.score,
    ].every(Number.isFinite) ||
    !Number.isFinite(Date.parse(preview.expires_at)) ||
    !Number.isFinite(Date.parse(preview.computed_at))
  )
    return false;
  const constraints = preview.settings?.constraints as
    RoutingConstraints | undefined;
  const keys: Array<keyof RoutingConstraints> = [
    "max_duration_minutes",
    "max_stops_per_crew",
    "return_to_start",
    "allow_partial",
  ];
  if (
    !constraints ||
    keys.some((key) => constraints[key] !== entry.constraints[key])
  )
    return false;
  if (entry.previewId && preview.id !== entry.previewId) return false;
  const selected = new Set(entry.jobIds),
    crews = new Set(entry.crewIds);
  const stops = preview.routes.flatMap((route) =>
    Array.isArray(route.stops) ? route.stops : [],
  );
  if (
    new Set(stops.map((stop) => stop.job_id)).size !== stops.length ||
    (preview.dispatchable && preview.routes.length !== crews.size) ||
    new Set(preview.routes.map((route) => route.crew_id)).size !==
      preview.routes.length ||
    new Set(preview.job_ids).size !== preview.job_ids.length
  )
    return false;
  const accounted = new Set(
    [...stops, ...preview.unassigned, ...preview.exclusions].map(
      (item) => item.job_id,
    ),
  );
  if (
    accounted.size !== selected.size ||
    entry.jobIds.some((id) => !accounted.has(id))
  )
    return false;
  return (
    preview.job_ids.length === selected.size &&
    preview.job_ids.every((id) => selected.has(id)) &&
    preview.routes.every(
      (route) =>
        crews.has(route.crew_id) &&
        Array.isArray(route.stops) &&
        route.stops.every((stop) => selected.has(stop.job_id)),
    ) &&
    [...preview.unassigned, ...preview.exclusions].every((issue) =>
      selected.has(issue.job_id),
    ) &&
    preview.reassignments.every(
      (move) => selected.has(move.job_id) && crews.has(move.proposed_crew_id),
    )
  );
}
export function matchingReceipt(
  preview: OrganizerRoutePreview,
  entry: DispatchJournal,
  actorId: string,
): boolean {
  const receipt = preview.dispatch_receipt;
  return (
    !!receipt &&
    !!entry.commandId &&
    !!preview.plan_id &&
    preview.id === entry.previewId &&
    receipt.command_id === entry.commandId &&
    receipt.actor_id === actorId &&
    receipt.plan_id === preview.plan_id &&
    receipt.accept_partial === entry.acceptPartial
  );
}
