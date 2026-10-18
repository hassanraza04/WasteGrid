import { useState } from "react";

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

type PendingDecision = { decision: DecisionCommand; priority: { commandId: string; priority: Priority; reason: string } | null };

export function OrganizerDecisionForm({ report, api, onReportUpdated, onReload, onSessionExpired }: { report: OrganizerReport; api: OrganizerApi; onReportUpdated: (report: OrganizerReport) => void; onReload: () => void; onSessionExpired?: (error: AccessError) => void }) {
  const [draft, setDraft] = useState<Draft>(() => fromReport(report));
  const [validation, setValidation] = useState("");
  const [pending, setPending] = useState<PendingDecision | null>(null);
  const [decisionSaved, setDecisionSaved] = useState<OrganizerReport | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) { setDraft(current => ({ ...current, [key]: value })); }
  function toggleEquipment(value: Equipment) { update("selectedEquipment", draft.selectedEquipment.includes(value) ? draft.selectedEquipment.filter(item => item !== value) : [...draft.selectedEquipment, value]); }

  function review() {
    const invalid = validate(draft);
    if (invalid) { setValidation(invalid); return; }
    const decision: DecisionCommand = {
      command_id: crypto.randomUUID(), expected_version: report.version, report_id: report.id, category: draft.category.trim(),
      proposed_equipment: draft.selectedEquipment, duplicate_candidate_id: draft.duplicateCandidateId.trim() || null,
      duplicate_confirmed: draft.duplicateConfirmed, hazard: draft.hazard, evidence_sufficient: draft.evidenceSufficient,
      missing_information: list(draft.missingInformation), decision_summary: draft.decisionSummary.trim(),
      evidence_report_ids: list(draft.evidenceReportIds), next_action: draft.nextAction,
      estimated_service_minutes: draft.estimatedServiceMinutes ? Number(draft.estimatedServiceMinutes) : null,
    };
    setValidation(""); setError(""); setDecisionSaved(null);
    setPending({ decision, priority: draft.priority ? { commandId: crypto.randomUUID(), priority: draft.priority, reason: draft.priorityReason.trim() } : null });
  }

  async function apply() {
    if (!pending || saving) return;
    setSaving(true); setError("");
    try {
      const decisionResult = decisionSaved ?? await api.applyDecision(report.id, pending.decision);
      if (pending.priority) {
        const command: PriorityCommand = { command_id: pending.priority.commandId, expected_version: decisionResult.version, priority: pending.priority.priority, reason: pending.priority.reason };
        try {
          const priorityResult = await api.setPriority(report.id, command);
          onReportUpdated(priorityResult); clear();
        } catch (caught) {
          if (caught instanceof AccessError) { onSessionExpired?.(caught); return; }
          setDecisionSaved(decisionResult);
          setError(`The triage decision was saved. ${safeMessage(caught)} Retry the priority update when ready.`);
        }
      } else {
        onReportUpdated(decisionResult); clear();
      }
    } catch (caught) {
      if (caught instanceof AccessError) { onSessionExpired?.(caught); return; }
      setError(safeMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  function clear() { setPending(null); setDecisionSaved(null); setError(""); }
  function reloadAfterStale() { clear(); onReload(); }

  if (pending) return <section aria-label="Review organiser decision">
    <h4>Review decision</h4>
    <p>Category: {pending.decision.category}</p><p>Equipment: {pending.decision.proposed_equipment.join(", ")}</p>
    <p>Duplicate candidate: {pending.decision.duplicate_candidate_id ?? "None"}</p><p>Duplicate confirmed: {String(pending.decision.duplicate_confirmed)}</p>
    <p>Hazard: {String(pending.decision.hazard)}</p><p>Evidence sufficient: {String(pending.decision.evidence_sufficient)}</p>
    <p>Missing information: {pending.decision.missing_information.join(", ") || "None"}</p><p>Decision summary: {pending.decision.decision_summary}</p>
    <p>Next action: {pending.decision.next_action}</p><p>Evidence: {pending.decision.evidence_report_ids.join(", ")}</p>
    <p>Estimated service minutes: {pending.decision.estimated_service_minutes ?? "Not recorded"}</p>
    <p>Priority: {pending.priority?.priority ?? "Unchanged"}</p><p>Priority reason: {pending.priority?.reason ?? "Not recorded"}</p>
    <p>Applying this decision creates an attributed organiser event. It does not start a worker or send a message.</p>
    {error && <p role="alert">{error}</p>}
    {error.includes("changed or is not ready") ? <button onClick={reloadAfterStale}>Reload latest report</button> : <button disabled={saving} onClick={() => void apply()}>{error ? "Retry organiser decision" : "Apply organiser decision"}</button>}
    <button disabled={saving} onClick={clear}>Edit decision</button>
  </section>;

  return <section aria-label="Organiser decision form">
    <label>Category<input value={draft.category} onChange={event => update("category", event.target.value)} /></label>
    <fieldset><legend>Equipment</legend>{equipment.map(item => <label key={item.value}><input type="checkbox" checked={draft.selectedEquipment.includes(item.value)} onChange={() => toggleEquipment(item.value)} />{item.label}</label>)}</fieldset>
    <label>Duplicate report ID<input value={draft.duplicateCandidateId} onChange={event => update("duplicateCandidateId", event.target.value)} /></label>
    <label><input type="checkbox" checked={draft.duplicateConfirmed} onChange={event => update("duplicateConfirmed", event.target.checked)} />Confirm duplicate</label>
    <label><input type="checkbox" checked={draft.hazard} onChange={event => update("hazard", event.target.checked)} />Hazard present</label>
    <label><input type="checkbox" checked={draft.evidenceSufficient} onChange={event => update("evidenceSufficient", event.target.checked)} />Evidence sufficient</label>
    <label>Missing information<input value={draft.missingInformation} onChange={event => update("missingInformation", event.target.value)} /></label>
    <label>Decision summary<textarea value={draft.decisionSummary} onChange={event => update("decisionSummary", event.target.value)} /></label>
    <label>Evidence report IDs<input value={draft.evidenceReportIds} onChange={event => update("evidenceReportIds", event.target.value)} /></label>
    <label>Next action<select value={draft.nextAction} onChange={event => update("nextAction", event.target.value as NextAction)}><option value="review">Review</option><option value="create_job">Create job</option><option value="link_job">Link job</option><option value="request_info">Request information</option></select></label>
    <label>Estimated service minutes<input inputMode="numeric" value={draft.estimatedServiceMinutes} onChange={event => update("estimatedServiceMinutes", event.target.value)} /></label>
    <label>Priority override<select value={draft.priority} onChange={event => update("priority", event.target.value as Draft["priority"])}><option value="">Leave unchanged</option><option value="high">High</option><option value="medium">Medium</option><option value="routine">Routine</option></select></label>
    {draft.priority && <label>Priority reason<textarea value={draft.priorityReason} onChange={event => update("priorityReason", event.target.value)} /></label>}
    {validation && <p role="alert">{validation}</p>}
    <button onClick={review}>Review decision</button>
  </section>;
}

function fromReport(report: OrganizerReport): Draft {
  const triage = report.triage;
  return { category: triage?.category ?? "", selectedEquipment: triage?.proposed_equipment ?? [], duplicateCandidateId: triage?.duplicate_candidate_id ?? "", duplicateConfirmed: triage?.duplicate_confirmed ?? false, hazard: triage?.hazard ?? false, evidenceSufficient: triage?.evidence_sufficient ?? false, missingInformation: triage?.missing_information.join(", ") ?? "", decisionSummary: triage?.decision_summary ?? "", evidenceReportIds: triage?.evidence_report_ids.join(", ") ?? report.id, nextAction: triage?.next_action ?? "review", estimatedServiceMinutes: triage?.estimated_service_minutes?.toString() ?? "", priority: "", priorityReason: "" };
}

function validate(draft: Draft): string {
  if (!draft.category.trim()) return "A category is required.";
  if (!draft.selectedEquipment.length) return "Select at least one equipment item.";
  if (!draft.decisionSummary.trim()) return "A decision summary is required.";
  if (draft.duplicateConfirmed && !draft.duplicateCandidateId.trim()) return "A duplicate report ID is required when confirming a duplicate.";
  if (draft.estimatedServiceMinutes && (!/^\d+$/.test(draft.estimatedServiceMinutes) || Number(draft.estimatedServiceMinutes) < 1 || Number(draft.estimatedServiceMinutes) > 1440)) return "Service minutes must be a whole number from 1 to 1440.";
  if (draft.priority && !draft.priorityReason.trim()) return "A priority reason is required.";
  return "";
}

function list(value: string) { return [...new Set(value.split(",").map(item => item.trim()).filter(Boolean))]; }
function safeMessage(caught: unknown) { return caught instanceof Error ? caught.message : "Unable to save the organiser decision. Please retry."; }
