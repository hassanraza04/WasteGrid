import { useEffect, useRef, useState } from "react";

import { AccessError, type DecisionCommand, type Equipment, type NextAction, type OrganizerApi, type OrganizerReport, type Priority, type PriorityCommand } from "./organizerApi";

const equipment: Array<{ value: Equipment; label: string }> = [
  { value: "gloves", label: "Gloves" }, { value: "trash_bags", label: "Trash bags" },
  { value: "broom", label: "Broom" }, { value: "shovel", label: "Shovel" },
  { value: "wheelbarrow", label: "Wheelbarrow" }, { value: "pickup_truck", label: "Pickup truck" },
];

type Draft = {
  category: string; selectedEquipment: Equipment[]; duplicateCandidateId: string; duplicateConfirmed: boolean;
  hazard: boolean; evidenceSufficient: boolean; missingInformation: string; decisionSummary: string;
  evidenceReportIds: string; nextAction: NextAction; estimatedServiceMinutes: string; priority: "" | Priority; priorityReason: string;
};

type Props = { report: OrganizerReport; api: OrganizerApi; onReportUpdated: (report: OrganizerReport) => void; onReload: () => Promise<OrganizerReport | null>; onSessionExpired?: (error: AccessError) => void };
type PendingDecision = { decision: DecisionCommand | null; priority: { commandId: string; priority: Priority; reason: string } | null; sessionVersion: number | undefined; api: OrganizerApi; reportSnapshot: OrganizerReport };

export function OrganizerDecisionForm(props: Props) {
  // A different report or account gets its own draft and invalidates pending work.
  return <DecisionForm key={`${props.report.id}:${props.api.sessionVersion}`} {...props} />;
}

function DecisionForm({ report, api, onReportUpdated, onReload, onSessionExpired }: Props) {
  const [draft, setDraft] = useState<Draft>(() => fromReport(report));
  const [validation, setValidation] = useState("");
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [decisionSaved, setDecisionSaved] = useState<OrganizerReport | null>(null);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const mounted = useRef(true);
  const currentApi = useRef(api);
  currentApi.current = api;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const priorityOnly = report.state === "linked_to_job";

  function isCurrent(operation: PendingDecision) { return mounted.current && currentApi.current === operation.api && operation.api.sessionVersion === operation.sessionVersion; }
  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => ({ ...current, [key]: value })); }
  function toggleEquipment(value: Equipment) { update("selectedEquipment", draft.selectedEquipment.includes(value) ? draft.selectedEquipment.filter(item => item !== value) : [...draft.selectedEquipment, value]); }

  function review() {
    const invalid = validate(draft, priorityOnly);
    if (invalid) { setValidation(invalid); return; }
    const candidate = draft.duplicateCandidateId.trim() || null;
    const evidence = list(draft.evidenceReportIds);
    if (draft.nextAction === "link_job" && candidate && !evidence.includes(candidate)) evidence.push(candidate);
    const decision: DecisionCommand | null = priorityOnly ? null : {
      command_id: crypto.randomUUID(), expected_version: report.version, report_id: report.id, category: draft.category.trim(),
      proposed_equipment: draft.selectedEquipment, duplicate_candidate_id: candidate,
      duplicate_confirmed: draft.duplicateConfirmed, hazard: draft.hazard, evidence_sufficient: draft.evidenceSufficient,
      missing_information: list(draft.missingInformation), decision_summary: draft.decisionSummary.trim(),
      evidence_report_ids: evidence, next_action: draft.nextAction,
      estimated_service_minutes: draft.estimatedServiceMinutes ? Number(draft.estimatedServiceMinutes) : null,
    };
    setValidation(""); setError(""); setOutcome(""); setDecisionSaved(null);
    setPending({ decision, priority: draft.priority ? { commandId: crypto.randomUUID(), priority: draft.priority, reason: draft.priorityReason.trim() } : null, sessionVersion: api.sessionVersion, api, reportSnapshot: report });
  }

  async function apply() {
    if (!pending || saving || !isCurrent(pending)) return;
    const operation = pending;
    setSaving(true); setError("");
    try {
      const decisionResult = decisionSaved ?? (operation.decision ? await api.applyDecision(report.id, operation.decision) : operation.reportSnapshot);
      if (!isCurrent(operation)) return;
      if (operation.priority) {
        const command: PriorityCommand = { command_id: operation.priority.commandId, expected_version: decisionResult.version, priority: operation.priority.priority, reason: operation.priority.reason };
        try {
          const priorityResult = await api.setPriority(report.id, command);
          if (!isCurrent(operation)) return;
          setOutcome(`Priority update recorded. Current priority: ${priorityResult.priority}. ${reportOutcome(priorityResult)}`);
          onReportUpdated(priorityResult);
          if (isCurrent(operation)) clear(priorityResult);
        } catch (caught) {
          if (!isCurrent(operation)) return;
          if (caught instanceof AccessError) { onSessionExpired?.(caught); return; }
          // Keep this snapshot, command ID and version for an uncertain-result retry.
          setDecisionSaved(decisionResult);
          if (operation.decision) setOutcome(`Decision saved. ${reportOutcome(decisionResult)}`);
          setError(`${operation.decision ? "The triage decision was saved. " : ""}${safeMessage(caught)} Retry the priority update when ready.`);
          setStale(isStale(caught));
          if (operation.decision) onReportUpdated(decisionResult);
        }
      } else {
        setOutcome(`Decision saved. ${reportOutcome(decisionResult)}`);
        onReportUpdated(decisionResult);
        if (isCurrent(operation)) clear(decisionResult);
      }
    } catch (caught) {
      if (!isCurrent(operation)) return;
      if (caught instanceof AccessError) { onSessionExpired?.(caught); return; }
      setError(safeMessage(caught));
      setStale(isStale(caught));
    } finally {
      if (isCurrent(operation)) setSaving(false);
    }
  }

  function clear(saved?: OrganizerReport) { if (saved) setDraft(fromReport(saved)); setPending(null); setDecisionSaved(null); setError(""); setStale(false); }
  async function reloadAfterStale() {
    if (!pending || saving || !isCurrent(pending)) return;
    const operation = pending;
    setSaving(true); setError("");
    try {
      const refreshed = await onReload();
      if (!isCurrent(operation)) return;
      if (refreshed && decisionSaved) {
        // A definite conflict did not commit this priority command, so its version may be rebased.
        setDecisionSaved(refreshed);
        setStale(false);
      } else if (refreshed) clear();
      else setError("Unable to refresh the latest report. Keep this draft and retry the reload.");
    } catch (caught) {
      if (!isCurrent(operation)) return;
      if (caught instanceof AccessError) onSessionExpired?.(caught);
      else setError(safeMessage(caught));
    } finally {
      if (isCurrent(operation)) setSaving(false);
    }
  }

  if (pending) return <section aria-label="Review organiser decision">
    <h4>{pending.decision ? "Review decision" : "Review priority update"}</h4>
    {pending.decision && <>
      <p>Category: {pending.decision.category}</p><p>Equipment: {pending.decision.proposed_equipment.join(", ") || "None recorded"}</p>
      <p>Duplicate candidate: {pending.decision.duplicate_candidate_id ?? "None"}</p><p>Duplicate confirmed: {String(pending.decision.duplicate_confirmed)}</p>
      <p>Hazard: {String(pending.decision.hazard)}</p><p>Evidence sufficient: {String(pending.decision.evidence_sufficient)}</p>
      <p>Missing information: {pending.decision.missing_information.join(", ") || "None"}</p><p>Decision summary: {pending.decision.decision_summary}</p>
      <p>Next action: {pending.decision.next_action}</p><p>Evidence: {pending.decision.evidence_report_ids.join(", ")}</p>
      <p>Estimated service minutes: {pending.decision.estimated_service_minutes ?? "Not recorded"}</p>
    </>}
    <p>Priority: {pending.priority?.priority ?? "Unchanged"}</p><p>Priority reason: {pending.priority?.reason ?? "Not recorded"}</p>
    <p>Applying this decision creates an attributed organiser event. It does not start a worker or send a message.</p>
    {outcome && <p role="status">{outcome}</p>}
    {error && <p role="alert">{error}</p>}
    {stale ? <button disabled={saving} onClick={() => void reloadAfterStale()}>Reload latest report</button> : <button disabled={saving} onClick={() => void apply()}>{decisionSaved || !pending.decision ? (error ? "Retry priority update" : "Apply priority update") : (error ? "Retry organiser decision" : "Apply organiser decision")}</button>}
    {!stale && <button disabled={saving} onClick={() => clear()}>Edit decision</button>}
  </section>;

  return <section aria-label="Organiser decision form">
    {outcome && <p role="status">{outcome}</p>}
    {!priorityOnly && <>
      <label>Category<input maxLength={100} value={draft.category} onChange={event => update("category", event.target.value)} /></label>
      <fieldset><legend>Equipment</legend>{equipment.map(item => <label key={item.value}><input type="checkbox" checked={draft.selectedEquipment.includes(item.value)} onChange={() => toggleEquipment(item.value)} />{item.label}</label>)}</fieldset>
      <label>Duplicate report ID<input value={draft.duplicateCandidateId} onChange={event => update("duplicateCandidateId", event.target.value)} /></label>
      <label><input type="checkbox" checked={draft.duplicateConfirmed} onChange={event => update("duplicateConfirmed", event.target.checked)} />Confirm duplicate</label>
      <label><input type="checkbox" checked={draft.hazard} onChange={event => update("hazard", event.target.checked)} />Hazard present</label>
      <label><input type="checkbox" checked={draft.evidenceSufficient} onChange={event => update("evidenceSufficient", event.target.checked)} />Evidence sufficient</label>
      <label>Missing information<input value={draft.missingInformation} onChange={event => update("missingInformation", event.target.value)} /></label>
      <label>Decision summary<textarea maxLength={2000} value={draft.decisionSummary} onChange={event => update("decisionSummary", event.target.value)} /></label>
      <label>Evidence report IDs<input value={draft.evidenceReportIds} onChange={event => update("evidenceReportIds", event.target.value)} /></label>
      <label>Next action<select value={draft.nextAction} onChange={event => update("nextAction", event.target.value as NextAction)}><option value="review">Review</option><option value="create_job">Create job</option><option value="link_job">Link job</option><option value="request_info">Request information</option></select></label>
      <label>Estimated service minutes<input inputMode="numeric" value={draft.estimatedServiceMinutes} onChange={event => update("estimatedServiceMinutes", event.target.value)} /></label>
    </>}
    {priorityOnly && <p>This report is already linked to a job. Its priority can be reviewed separately.</p>}
    <label>Priority override<select value={draft.priority} onChange={event => update("priority", event.target.value as Draft["priority"])}><option value="">Leave unchanged</option><option value="high">High</option><option value="medium">Medium</option><option value="routine">Routine</option></select></label>
    {draft.priority && <label>Priority reason<textarea maxLength={1000} value={draft.priorityReason} onChange={event => update("priorityReason", event.target.value)} /></label>}
    {validation && <p role="alert">{validation}</p>}
    <button onClick={review}>Review decision</button>
  </section>;
}

function fromReport(report: OrganizerReport): Draft {
  const triage = report.triage;
  return { category: triage?.category ?? "", selectedEquipment: triage?.proposed_equipment ?? [], duplicateCandidateId: triage?.duplicate_candidate_id ?? "", duplicateConfirmed: triage?.duplicate_confirmed ?? false, hazard: triage?.hazard ?? false, evidenceSufficient: triage?.evidence_sufficient ?? false, missingInformation: triage?.missing_information.join(", ") ?? "", decisionSummary: triage?.decision_summary ?? "", evidenceReportIds: triage?.evidence_report_ids.join(", ") ?? report.id, nextAction: triage?.next_action ?? "review", estimatedServiceMinutes: triage?.estimated_service_minutes?.toString() ?? "", priority: "", priorityReason: "" };
}

function validate(draft: Draft, priorityOnly: boolean): string {
  if (priorityOnly) {
    if (!draft.priority) return "Choose a priority override to review.";
  } else {
    if (!draft.category.trim()) return "A category is required.";
    if (draft.nextAction === "create_job" && !draft.selectedEquipment.length) return "Select at least one equipment item to create a job.";
    if (!draft.decisionSummary.trim()) return "A decision summary is required.";
    if ((draft.duplicateConfirmed || draft.nextAction === "link_job") && !draft.duplicateCandidateId.trim()) return "A duplicate report ID is required when linking or confirming a duplicate.";
    if (draft.nextAction === "link_job" && !draft.duplicateConfirmed) return "Confirm the duplicate before linking its job.";
    if (draft.estimatedServiceMinutes && (!/^\d+$/.test(draft.estimatedServiceMinutes) || Number(draft.estimatedServiceMinutes) < 1 || Number(draft.estimatedServiceMinutes) > 1440)) return "Service minutes must be a whole number from 1 to 1440.";
    if (draft.nextAction === "create_job" && !draft.estimatedServiceMinutes) return "A service-time estimate is required to create a job.";
  }
  if (draft.priority && !draft.priorityReason.trim()) return "A priority reason is required.";
  return "";
}

function list(value: string) { return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))]; }
function safeMessage(caught: unknown) { return caught instanceof Error ? caught.message : "Unable to save the organiser decision. Please retry."; }
function isStale(caught: unknown) { return caught instanceof Error && caught.message.includes("changed or is not ready"); }
function reportOutcome(report: OrganizerReport) {
  const job = report.job_id ? `Linked cleanup job: ${report.job_id}.` : "No cleanup job is linked.";
  if (report.needs_review || report.state === "needs_review") return `The report still requires organiser review. ${job}`;
  if (report.state === "needs_info") return `More information is required. ${job}`;
  return `Report state: ${report.state}. ${job}`;
}
