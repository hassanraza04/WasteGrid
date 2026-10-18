import { useEffect, useRef, useState } from "react";
import {
  AccessError,
  RoutingConflictError,
  RoutingContractError,
  type OrganizerApi,
  type OrganizerRoutePreview,
} from "./organizerApi";
import {
  emptyJournal,
  matchingReceipt,
  readJournal,
  sameScope,
  writeJournal,
  JournalUnavailable,
  type DispatchJournal,
} from "./dispatchJournal";
import { OrganizerRouteMap } from "./OrganizerRouteMap";
import { crewGpsAge, crewGpsIssue } from "./crewGps";
import {
  Alert,
  Chip,
  Dialog,
  LoadingState,
  useForegroundRefresh,
} from "./OrganizerUI";

type Props = {
  api: OrganizerApi;
  onSessionExpired: (error: AccessError) => void;
};
async function loadRoutingState(api: OrganizerApi) {
  const [crewState, jobs, currentPlan] = await Promise.all([
    api.crews().then(crews => ({ crews, receivedAt: performance.now() })),
    api.indexedJobs(),
    api.currentPlan(),
  ]);
  return { crews: crewState.crews, crewsReceivedAt: crewState.receivedAt, jobs, currentPlan };
}
type RoutingState = Awaited<ReturnType<typeof loadRoutingState>>;
const minutes = (value: number) => `${Math.round(value * 10) / 10} min`;

export function OrganizerDispatchWorkspace({ api, onSessionExpired }: Props) {
  const [state, setState] = useState<RoutingState | null>(null);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const [entry, setEntry] = useState<DispatchJournal>(emptyJournal);
  const [preview, setPreview] = useState<OrganizerRoutePreview | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(false),
    [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState(false),
    [partialConfirmed, setPartialConfirmed] = useState(false);
  const [illustrative, setIllustrative] = useState(
    () =>
      new URLSearchParams(window.location.search).get("illustrative") ===
      "true",
  );
  const mounted = useRef(true),
    generation = useRef(0),
    refreshGeneration = useRef(0),
    locked = useRef(false);
  const pendingWrites = useRef<Promise<void>>(Promise.resolve());
  const actor = api.verifiedUserId ?? "",
    environment = api.environment;
  const frozen = entry.stage === "attempted" || entry.stage === "committed";
  const disabled = busy || loading || frozen || !storageReady;
  const current = (request: number, version: number) =>
    mounted.current &&
    generation.current === request &&
    api.sessionVersion === version;

  function fail(caught: unknown) {
    if (caught instanceof AccessError) onSessionExpired(caught);
    else
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to complete routing operation.",
      );
  }
  async function persist(next: DispatchJournal) {
    const write = pendingWrites.current
      .catch(() => undefined)
      .then(() => writeJournal(environment, actor, next));
    pendingWrites.current = write;
    await write;
  }
  useEffect(() => {
    mounted.current = true;
    locked.current = false;
    setBusy(false);
    setLoading(true);
    setStorageReady(false);
    setState(null);
    setEntry(emptyJournal());
    setPreview(null);
    setConfirmation(false);
    setPartialConfirmed(false);
    setError("");
    const request = ++generation.current,
      version = api.sessionVersion;
    void (async () => {
      try {
        const saved = await readJournal(environment, actor);
        if (!current(request, version)) return;
        const restored = saved ?? emptyJournal();
        setEntry(restored);
        setStorageReady(true);
        if (restored.previewId && restored.stage !== "conflict") {
          const original = await api.preview(restored.previewId);
          if (!current(request, version)) return;
          if (!sameScope(original, restored))
            throw new RoutingContractError(
              "Saved preview does not match its reviewed scope. Dispatch remains blocked.",
            );
          if (original.plan_id && !matchingReceipt(original, restored, actor))
            throw new RoutingContractError(
              "A different dispatch receipt exists. Refresh operational state before continuing.",
            );
          setPreview(original);
          if (original.plan_id) {
            const committed = { ...restored, stage: "committed" as const };
            await persist(committed);
            if (current(request, version)) setEntry(committed);
          } else if (restored.stage === "attempted")
            setError(
              "Dispatch outcome is unconfirmed. Inspect and recover the original command below.",
            );
        }
      } catch (caught) {
        if (current(request, version)) {
          if (caught instanceof JournalUnavailable) setStorageReady(false);
          fail(caught);
        }
      }
      try {
        const next = await loadRoutingState(api);
        if (current(request, version)) setState(next);
      } catch (caught) {
        if (current(request, version)) fail(caught);
      } finally {
        if (current(request, version)) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [api, actor, environment]);

  async function refresh() {
    const version = api.sessionVersion,
      request = generation.current,
      refreshRequest = ++refreshGeneration.current;
    try {
      const next = await loadRoutingState(api);
      if (
        current(request, version) &&
        refreshRequest === refreshGeneration.current
      )
        setState(next);
    } catch (caught) {
      if (
        current(request, version) &&
        refreshRequest === refreshGeneration.current
      )
        fail(caught);
    }
  }
  useForegroundRefresh(() => {
    if (!locked.current) void refresh();
  });

  function change(next: DispatchJournal) {
    if (disabled || locked.current) return;
    next = {
      ...next,
      previewId: null,
      commandId: null,
      acceptPartial: false,
      stage: "selection",
    };
    setEntry(next);
    setPreview(null);
    setPartialConfirmed(false);
    setError("");
    const version = api.sessionVersion;
    void persist(next).catch((caught) => {
      if (mounted.current && version === api.sessionVersion) {
        setStorageReady(false);
        fail(caught);
      }
    });
  }
  const selectedCrewJobs =
    state?.jobs.filter(
      (job) =>
        job.assigned_crew_id &&
        entry.crewIds.includes(job.assigned_crew_id) &&
        !entry.jobIds.includes(job.id),
    ) ?? [];
  const foreignJobs =
    state?.jobs.filter(
      (job) =>
        entry.jobIds.includes(job.id) &&
        job.assigned_crew_id &&
        !entry.crewIds.includes(job.assigned_crew_id),
    ) ?? [];
  const missingSelected = entry.jobIds.filter(
    (id) => !state?.jobs.some((job) => job.id === id),
  );
  const missingCrews = entry.crewIds.some(
    (id) => !state?.crews.some((crew) => crew.id === id && crew.available),
  );
  const gpsElapsed = state ? Math.max(0, now - state.crewsReceivedAt) : 0;
  const invalidGpsCrew = state?.crews.find(
    (crew) => entry.crewIds.includes(crew.id) && crewGpsIssue(crew, gpsElapsed),
  );
  const scopeIssue = invalidGpsCrew
    ? `${invalidGpsCrew.name}: ${crewGpsIssue(invalidGpsCrew, gpsElapsed)}. Share fresh GPS from this crew’s mobile screen, then refresh routing state.`
    : missingCrews
      ? "Selected crews are no longer available. Review your selection."
      : !entry.crewIds.length
        ? "Select at least one crew."
        : !entry.jobIds.length
          ? "Select at least one job."
          : selectedCrewJobs.length
            ? "Include every unfinished job assigned to a selected crew."
            : foreignJobs.length
              ? "Select the crew assigned to every reviewed job."
              : missingSelected.length
                ? "Some selected jobs are no longer active. Review your selection."
                : "";
  const label = (id: string) => {
    const job = state?.jobs.find((item) => item.id === id);
    return job
      ? `${job.category} · ${job.public_references.join(", ") || id}`
      : id;
  };
  const crewName = (id: string) =>
    state?.crews.find((crew) => crew.id === id)?.name ?? id;
  const omissions = preview
    ? [...preview.unassigned, ...preview.exclusions]
    : [];

  async function computePreview() {
    if (disabled || locked.current || scopeIssue) return;
    // Recheck at the click boundary in case a background tab delayed the timer.
    if (state?.crews.some(
      (crew) => entry.crewIds.includes(crew.id) && crewGpsIssue(crew, performance.now() - state.crewsReceivedAt),
    )) {
      setNow(performance.now());
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    setPreview(null);
    setPartialConfirmed(false);
    const version = api.sessionVersion,
      request = ++generation.current;
    try {
      await persist(entry);
      if (!current(request, version)) return;
      const result = await api.previewRouting(
        entry.crewIds,
        entry.jobIds,
        entry.constraints,
      );
      if (!sameScope(result, entry))
        throw new RoutingContractError(
          "The routing service did not confirm the selected job scope. Refresh and compute again.",
        );
      if (!current(request, version)) return;
      const next = {
        ...entry,
        previewId: result.id,
        commandId: crypto.randomUUID(),
        stage: "reviewed" as const,
      };
      await persist(next);
      if (current(request, version)) {
        setEntry(next);
        setPreview(result);
      }
    } catch (caught) {
      if (current(request, version)) {
        if (caught instanceof RoutingConflictError) await refresh();
        if (current(request, version)) fail(caught);
      }
    } finally {
      if (current(request, version)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  async function dispatch(recover = false) {
    if (
      (!preview && !recover) ||
      !entry.commandId ||
      !entry.previewId ||
      locked.current ||
      !storageReady
    )
      return;
    if (
      !recover &&
      preview &&
      (!preview.dispatchable ||
        Date.parse(preview.expires_at) <= Date.now() ||
        (omissions.length > 0 && !partialConfirmed))
    ) {
      setError(
        "Review partial omissions and use a fresh dispatchable preview.",
      );
      setConfirmation(false);
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    setConfirmation(false);
    const version = api.sessionVersion,
      request = ++generation.current;
    const attempt = {
      ...entry,
      stage: "attempted" as const,
      acceptPartial: recover
        ? entry.acceptPartial
        : omissions.length > 0 && partialConfirmed,
    };
    try {
      // Recover is GET first, even if an earlier response or storage commit was lost.
      if (recover) {
        const original = await api.preview(attempt.previewId!);
        if (!current(request, version)) return;
        if (!sameScope(original, attempt))
          throw new RoutingContractError(
            "Original preview scope changed. Dispatch is blocked.",
          );
        setPreview(original);
        if (original.plan_id) {
          if (!matchingReceipt(original, attempt, actor))
            throw new RoutingContractError(
              "Dispatch receipt belongs to a different command or consent. Dispatch is blocked.",
            );
          const committed = { ...attempt, stage: "committed" as const };
          await persist(committed);
          if (current(request, version)) {
            setEntry(committed);
            setPreview(original);
            await refresh();
          }
          return;
        }
      }
      await persist(attempt); // Durable attempt barrier must commit before POST.
      if (!current(request, version)) return;
      setEntry(attempt);
      await api.dispatchRouting(
        attempt.previewId!,
        attempt.commandId!,
        attempt.acceptPartial,
      );
      if (!current(request, version)) return;
      // The persisted receipt, not a successful HTTP status alone, confirms the outcome.
      const committedPreview = await api.preview(attempt.previewId!);
      if (!matchingReceipt(committedPreview, attempt, actor))
        throw new RoutingContractError(
          "Dispatch response received but its receipt could not be verified. Recover the original command.",
        );
      const committed = { ...attempt, stage: "committed" as const };
      await persist(committed);
      if (current(request, version)) {
        setEntry(committed);
        setPreview(committedPreview);
        await refresh();
      }
    } catch (caught) {
      if (current(request, version)) {
        if (caught instanceof RoutingConflictError) {
          const conflict = { ...attempt, stage: "conflict" as const };
          try {
            await persist(conflict);
          } catch (storageError) {
            if (current(request, version)) {
              setStorageReady(false);
              fail(storageError);
            }
            return;
          }
          if (!current(request, version)) return;
          setEntry(conflict);
          setPreview(null);
          await refresh();
        }
        if (current(request, version)) fail(caught);
      }
    } finally {
      if (current(request, version)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  async function newReview() {
    if (locked.current || !storageReady || entry.stage === "attempted") return;
    locked.current = true;
    setBusy(true);
    const request = ++generation.current,
      version = api.sessionVersion;
    try {
      const next = {
        ...entry,
        previewId: null,
        commandId: null,
        acceptPartial: false,
        stage: "selection" as const,
      };
      await persist(next);
      if (!current(request, version)) return;
      setEntry(next);
      setPreview(null);
      setPartialConfirmed(false);
      setError("");
      await refresh();
    } catch (caught) {
      if (current(request, version)) fail(caught);
    } finally {
      if (current(request, version)) {
        locked.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div className="wg-routing">
      <div className="wg-page-heading">
        <div>
          <p className="wg-eyebrow">Operations</p>
          <h1>Routing workspace</h1>
          <p className="wg-muted">
            Road estimates and deterministic optimisation. An organiser confirms
            every dispatch.
          </p>
        </div>
        <button
          className="wg-button wg-secondary"
          onClick={() => void refresh()}
          disabled={busy}
        >
          Refresh routing state
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {entry.stage === "attempted" && (
        <section className="wg-card">
          <h2>Unconfirmed dispatch</h2>
          <p>
            The original scope, command and partial consent are frozen. Recovery
            checks its receipt before retrying.
          </p>
          <button
            className="wg-button"
            disabled={busy || !storageReady}
            onClick={() => void dispatch(true)}
          >
            Recover dispatch
          </button>
        </section>
      )}
      {entry.stage === "committed" && (
        <section className="wg-card" role="status">
          <h2>Dispatch confirmed</h2>
          <p>
            Plan {preview?.plan_id} · command {entry.commandId}
          </p>
          <div className="wg-actions">
            <button className="wg-button" onClick={() => window.print()}>
              Print committed route cards
            </button>
            <button
              className="wg-button wg-secondary"
              disabled={busy}
              onClick={() => void newReview()}
            >
              Start a new review
            </button>
          </div>
        </section>
      )}
      {entry.stage === "conflict" && (
        <Alert>
          Review the refreshed crews and jobs, then compute a new preview with
          a new command.
        </Alert>
      )}
      {loading ? (
        <LoadingState />
      ) : (
        state && (
          <>
            <section className="wg-card wg-no-print">
              <div className="wg-actions">
                <h2>Choose an explicit scope</h2>
                <label className="wg-check">
                  <input
                    type="checkbox"
                    checked={illustrative}
                    onChange={(event) => setIllustrative(event.target.checked)}
                  />
                  Include illustrative data
                </label>
              </div>
              <p className="wg-muted">
                Real jobs by default. Existing assigned work is always shown
                when its crew is selected.
              </p>
              <div className="wg-grid wg-two">
                <div>
                  <h3>Crews · {entry.crewIds.length}/5</h3>
                  {state.crews
                    .filter(
                      (crew) =>
                        illustrative ||
                        !crew.illustrative ||
                        entry.crewIds.includes(crew.id),
                    )
                    .map((crew) => {
                      const assigned = state.jobs.filter(
                        (job) => job.assigned_crew_id === crew.id,
                      );
                      const budget = Math.min(
                        crew.shift_minutes,
                        entry.constraints.max_duration_minutes ??
                          crew.shift_minutes,
                      );
                      const proposed = preview?.routes.find(
                        (route) => route.crew_id === crew.id,
                      );
                      const gpsIssue = crewGpsIssue(crew, gpsElapsed);
                      const age = crewGpsAge(crew, gpsElapsed);
                      return (
                        <article className="wg-routing-choice" key={crew.id}>
                          <div className="wg-actions">
                            <strong>{crew.name}</strong>
                            <Chip>
                              {crew.available ? "Available" : "Unavailable"}
                            </Chip>
                          </div>
                          <p className="wg-muted">
                            {crew.illustrative
                              ? "Illustrative crew"
                              : "Real crew"}{" "}
                            ·{" "}
                            {gpsIssue || (age === null ? "GPS timestamp received; server freshness check required" : `GPS fresh · ${age}s old`)}{" "}
                            ·{" "}
                            {proposed
                              ? `${Math.max(0, Math.round((budget - proposed.duration_minutes) * 10) / 10)} min remaining after preview`
                              : `${budget} min route budget; remaining determined by preview`}
                          </p>
                          {gpsIssue && (
                            <p>Open this crew’s mobile screen and share foreground GPS,
                              then refresh routing state.</p>
                          )}
                          <p>
                            {crew.equipment.join(", ").replaceAll("_", " ")}
                          </p>
                          <p>
                            {assigned.length} assigned jobs ·{" "}
                            {minutes(crew.shift_minutes)} shift
                          </p>
                          <button
                            className="wg-button wg-secondary"
                            aria-label={`${entry.crewIds.includes(crew.id) ? "Remove" : "Select"} ${crew.name} (${crew.id})`}
                            aria-pressed={entry.crewIds.includes(crew.id)}
                            disabled={
                              disabled ||
                              (!entry.crewIds.includes(crew.id) &&
                                (!crew.available || !!gpsIssue || entry.crewIds.length >= 5))
                            }
                            onClick={() =>
                              change({
                                ...entry,
                                crewIds: entry.crewIds.includes(crew.id)
                                  ? entry.crewIds.filter((id) => id !== crew.id)
                                  : [...entry.crewIds, crew.id],
                              })
                            }
                          >
                            {entry.crewIds.includes(crew.id)
                              ? "Remove"
                              : "Select"}{" "}
                            {crew.name}
                          </button>
                        </article>
                      );
                    })}
                </div>
                <div>
                  <h3>Jobs · {entry.jobIds.length}/25</h3>
                  {state.jobs
                    .filter(
                      (job) =>
                        illustrative ||
                        !job.illustrative ||
                        entry.jobIds.includes(job.id) ||
                        (job.assigned_crew_id &&
                          entry.crewIds.includes(job.assigned_crew_id)),
                    )
                    .map((job) => (
                      <article className="wg-routing-choice" key={job.id}>
                        <strong>{label(job.id)}</strong>
                        <div className="wg-actions">
                          <Chip>{job.priority ?? "Priority review"}</Chip>
                          <Chip>{job.status.replaceAll("_", " ")}</Chip>
                          {job.illustrative && <Chip>Illustrative</Chip>}
                        </div>
                        <p>
                          {job.address ??
                            job.location.landmark ??
                            "Location attached"}
                        </p>
                        <p className="wg-muted">
                          {job.assigned_crew_id
                            ? `Assigned to ${crewName(job.assigned_crew_id)}`
                            : "Unassigned"}{" "}
                          · {job.locked ? "fixed work" : "movable work"} ·{" "}
                          {minutes(job.estimated_service_minutes)} service
                        </p>
                        {job.eligibility_reasons.length > 0 && (
                          <p>
                            {job.eligibility_reasons
                              .join(", ")
                              .replaceAll("_", " ")}
                          </p>
                        )}
                        <button
                          className="wg-button wg-secondary"
                          aria-label={`${entry.jobIds.includes(job.id) ? "Remove" : "Select"} job ${job.category} (${job.id})`}
                          aria-pressed={entry.jobIds.includes(job.id)}
                          disabled={
                            disabled ||
                            (!job.eligible && !entry.jobIds.includes(job.id)) ||
                            (!entry.jobIds.includes(job.id) &&
                              entry.jobIds.length >= 25)
                          }
                          onClick={() =>
                            change({
                              ...entry,
                              jobIds: entry.jobIds.includes(job.id)
                                ? entry.jobIds.filter((id) => id !== job.id)
                                : [...entry.jobIds, job.id],
                            })
                          }
                        >
                          {entry.jobIds.includes(job.id) ? "Remove" : "Select"}{" "}
                          job
                        </button>
                      </article>
                    ))}
                </div>
              </div>
              {selectedCrewJobs.length > 0 && (
                <div className="wg-alert">
                  <p>
                    Required assigned jobs:{" "}
                    {selectedCrewJobs.map((job) => label(job.id)).join("; ")}
                  </p>
                  <button
                    className="wg-button wg-secondary"
                    disabled={
                      disabled ||
                      entry.jobIds.length + selectedCrewJobs.length > 25
                    }
                    onClick={() =>
                      change({
                        ...entry,
                        jobIds: [
                          ...entry.jobIds,
                          ...selectedCrewJobs.map((job) => job.id),
                        ],
                      })
                    }
                  >
                    Include required jobs
                  </button>
                  {entry.jobIds.length + selectedCrewJobs.length > 25 && (
                    <p>
                      The required scope exceeds 25 jobs. Choose fewer crews.
                    </p>
                  )}
                </div>
              )}
              {(missingSelected.length > 0 || missingCrews) && (
                <div className="wg-alert">
                  <p>
                    Unavailable selection:{" "}
                    {[
                      ...missingSelected,
                      ...entry.crewIds.filter(
                        (id) =>
                          !state.crews.some(
                            (crew) => crew.id === id && crew.available,
                          ),
                      ),
                    ].join(", ")}
                  </p>
                  <button
                    className="wg-button wg-secondary"
                    disabled={disabled}
                    onClick={() =>
                      change({
                        ...entry,
                        jobIds: entry.jobIds.filter((id) =>
                          state.jobs.some((job) => job.id === id),
                        ),
                        crewIds: entry.crewIds.filter((id) =>
                          state.crews.some(
                            (crew) => crew.id === id && crew.available,
                          ),
                        ),
                      })
                    }
                  >
                    Remove unavailable selections
                  </button>
                </div>
              )}
              <div className="wg-form-grid">
                <label className="wg-field">
                  Time limit (minutes)
                  <input
                    className="wg-input"
                    type="number"
                    min="1"
                    max="480"
                    value={entry.constraints.max_duration_minutes ?? ""}
                    disabled={disabled}
                    onChange={(event) => {
                      const value =
                        event.target.value === ""
                          ? null
                          : Number(event.target.value);
                      if (
                        value === null ||
                        (Number.isFinite(value) && value > 0 && value <= 480)
                      )
                        change({
                          ...entry,
                          constraints: {
                            ...entry.constraints,
                            max_duration_minutes: value,
                          },
                        });
                      else
                        setError(
                          "Time limit must be between 1 and 480 minutes, or empty for the crew shift limit.",
                        );
                    }}
                  />
                </label>
                <label className="wg-field">
                  Maximum stops
                  <input
                    className="wg-input"
                    type="number"
                    min="1"
                    max="25"
                    value={entry.constraints.max_stops_per_crew}
                    disabled={disabled}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isInteger(value) && value >= 1 && value <= 25)
                        change({
                          ...entry,
                          constraints: {
                            ...entry.constraints,
                            max_stops_per_crew: value,
                          },
                        });
                      else setError("Maximum stops must be between 1 and 25.");
                    }}
                  />
                </label>
                <label className="wg-check">
                  <input
                    type="checkbox"
                    checked={entry.constraints.return_to_start}
                    disabled={disabled}
                    onChange={(event) =>
                      change({
                        ...entry,
                        constraints: {
                          ...entry.constraints,
                          return_to_start: event.target.checked,
                        },
                      })
                    }
                  />
                  Return to start
                </label>
                <label className="wg-check">
                  <input
                    type="checkbox"
                    checked={entry.constraints.allow_partial}
                    disabled={disabled}
                    onChange={(event) =>
                      change({
                        ...entry,
                        constraints: {
                          ...entry.constraints,
                          allow_partial: event.target.checked,
                        },
                      })
                    }
                  />
                  Allow partial dispatch preview
                </label>
              </div>
              <p role="status">{scopeIssue}</p>
              <button
                className="wg-button"
                disabled={
                  disabled ||
                  !!scopeIssue ||
                  (entry.constraints.max_duration_minutes !== null &&
                    (entry.constraints.max_duration_minutes <= 0 ||
                      entry.constraints.max_duration_minutes > 480)) ||
                  entry.constraints.max_stops_per_crew < 1 ||
                  entry.constraints.max_stops_per_crew > 25
                }
                onClick={() => void computePreview()}
              >
                Compute route preview
              </button>
            </section>
            {state.currentPlan.plan && (
              <section className="wg-card wg-no-print">
                <h2>Current committed plan</h2>
                <p>
                  {state.currentPlan.plan.id} ·{" "}
                  {state.currentPlan.plan.stale
                    ? "changed, review before replanning"
                    : "current"}
                </p>
                {state.currentPlan.plan.assignments
                  .filter(
                    (assignment) =>
                      illustrative ||
                      state.jobs.some(
                        (job) =>
                          job.id === assignment.job_id && !job.illustrative,
                      ) ||
                      entry.crewIds.includes(assignment.crew_id),
                  )
                  .map((assignment) => (
                    <p key={assignment.job_id}>
                      {crewName(assignment.crew_id)} · stop{" "}
                      {assignment.position + 1} · {label(assignment.job_id)} ·{" "}
                      {assignment.travel_minutes} minutes travel ·{" "}
                      {assignment.service_minutes} minutes service{" "}
                      {state.jobs.find((job) => job.id === assignment.job_id)
                        ?.illustrative && <Chip>Illustrative</Chip>}
                    </p>
                  ))}
              </section>
            )}
          </>
        )
      )}
      {preview && (
        <section aria-label="Route preview">
          <div className="wg-page-heading">
            <div>
              <h2>
                {preview.plan_id ? "Committed routes" : "Preview for review"}
              </h2>
              <p>
                {preview.travel_label} ·{" "}
                {new Date(preview.computed_at).toLocaleString()} ·{" "}
                {preview.plan_id
                  ? `Plan ${preview.plan_id}`
                  : `Expires ${new Date(preview.expires_at).toLocaleTimeString()}`}
              </p>
              <p className="wg-muted">
                Preview {preview.id} · estimates; no live traffic
              </p>
            </div>
          </div>
          <div className="wg-card">
            <div className="wg-grid wg-three">
              <p>
                Weighted wait{" "}
                <strong>{preview.metrics.weighted_wait.toFixed(1)}</strong>
              </p>
              <p>
                Latest finish{" "}
                <strong>{minutes(preview.metrics.latest_finish)}</strong>
              </p>
              <p>
                Total travel{" "}
                <strong>{minutes(preview.metrics.total_travel)}</strong>
              </p>
            </div>
            <p className="wg-muted">
              Objective score {preview.metrics.score.toFixed(2)} ·{" "}
              {preview.termination_reason.replaceAll("_", " ")}
            </p>
          </div>
          <OrganizerRouteMap api={api} preview={preview} />
          <div className="wg-grid wg-two">
            {preview.routes.map((route) => (
              <article className="wg-card wg-print-route" key={route.crew_id}>
                <h3>{crewName(route.crew_id)}</h3>
                <p>
                  {minutes(route.duration_minutes)} total ·{" "}
                  {minutes(route.travel_minutes)} travel ·{" "}
                  {route.returns_to_start
                    ? `${minutes(route.return_travel_minutes ?? 0)} return to start`
                    : "Finish at last stop"}
                </p>
                <ol>
                  {route.stops.map((stop) => (
                    <li key={stop.job_id}>
                      <strong>{label(stop.job_id)}</strong>{" "}
                      {stop.fixed && <Chip>Fixed work</Chip>}
                      <p>
                        {minutes(stop.travel_minutes)} travel ·{" "}
                        {minutes(stop.service_minutes)} service · finish +
                        {minutes(stop.completion_minutes)}
                      </p>
                      <small>
                        {stop.priority} ·{" "}
                        {stop.service_estimate_source.replaceAll("_", " ")}
                      </small>
                    </li>
                  ))}
                </ol>
                {!route.stops.length && <p>No stops assigned.</p>}
                <small>
                  Plan {preview.plan_id ?? "Not dispatched"} · Estimate computed{" "}
                  {preview.computed_at} · {preview.travel_label}
                </small>
              </article>
            ))}
          </div>
          {preview.reassignments.length > 0 && (
            <section className="wg-card">
              <h3>Changes from current plan</h3>
              {preview.reassignments.map((move) => (
                <p key={move.job_id}>
                  {label(move.job_id)}:{" "}
                  {move.previous_crew_id
                    ? `${crewName(move.previous_crew_id)} stop ${(move.previous_position ?? 0) + 1}`
                    : "unassigned"}{" "}
                  → {crewName(move.proposed_crew_id)} stop{" "}
                  {move.proposed_position + 1}
                </p>
              ))}
            </section>
          )}
          {omissions.length > 0 && (
            <section className="wg-card">
              <h3>Omitted jobs</h3>
              {omissions.map((issue) => (
                <p key={issue.job_id}>
                  {label(issue.job_id)} · {issue.reason.replaceAll("_", " ")}
                </p>
              ))}
              {entry.stage === "reviewed" && (
                <label className="wg-check">
                  <input
                    type="checkbox"
                    checked={partialConfirmed}
                    onChange={(event) =>
                      setPartialConfirmed(event.target.checked)
                    }
                  />
                  I reviewed and accept these partial omissions
                </label>
              )}
            </section>
          )}
          {entry.stage === "reviewed" && (
            <div className="wg-actions wg-no-print">
              <button
                className="wg-button"
                disabled={
                  busy ||
                  !storageReady ||
                  !preview.dispatchable ||
                  Date.parse(preview.expires_at) <= Date.now() ||
                  (omissions.length > 0 && !partialConfirmed)
                }
                onClick={() => setConfirmation(true)}
              >
                Review dispatch
              </button>
              <button
                className="wg-button wg-secondary"
                disabled={busy}
                onClick={() => void newReview()}
              >
                Discard preview and review selection
              </button>
            </div>
          )}
        </section>
      )}
      {confirmation && (
        <Dialog title="Confirm dispatch" onClose={() => setConfirmation(false)}>
          <p>
            Commit{" "}
            {preview?.routes.reduce(
              (sum, route) => sum + route.stops.length,
              0,
            )}{" "}
            stops for {entry.crewIds.length} selected crews? This updates their
            assignments through server routing rules.
          </p>
          {omissions.length > 0 && (
            <p>
              You explicitly accepted {omissions.length} omitted jobs. They
              remain unassigned.
            </p>
          )}
          <div className="wg-actions">
            <button
              className="wg-button wg-secondary"
              onClick={() => setConfirmation(false)}
            >
              Cancel
            </button>
            <button className="wg-button" onClick={() => void dispatch()}>
              Confirm and dispatch
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
