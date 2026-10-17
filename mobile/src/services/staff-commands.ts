import type { Job, StaffClient } from "./staff-client";

export type StaffCommand = {
  command_id: string; kind: "start" | "completion" | "dispatch" | "release"; resource_id: string;
  ownerId: string; crewId?: string; apiUrl: string; expected_version?: number;
  photoUri?: string; rejected?: boolean; reason?: string;
};

// Recover by command identity, not merely by a matching status: another actor may
// have completed/started the job. Completion evidence must never be claimed as ours.
export async function recoverOrSend(command: StaffCommand, api: StaffClient, photo?: Blob): Promise<Job | { plan_id: string }> {
  if (command.kind === "dispatch") {
    const preview = await api.preview(command.resource_id);
    if (preview.plan_id) return { plan_id: preview.plan_id };
    return api.json<{ plan_id: string }>(`/routing/previews/${encodeURIComponent(command.resource_id)}/dispatch`, { command_id: command.command_id });
  }
  const details = await api.job(command.resource_id);
  const kind = command.kind === "completion" ? "job.completed" : "job.changed";
  if (details.events.some(event => event.command_id === command.command_id && event.kind === kind)) return details.job;
  if (command.kind !== "release" && details.job.assigned_crew_id !== command.crewId) throw new Error("This job is no longer assigned to your crew. Refresh your route.");
  if (command.kind === "start" || command.kind === "release") {
    return api.json<Job>(`/jobs/${encodeURIComponent(command.resource_id)}`, {
      command_id: command.command_id, expected_version: command.expected_version,
      status: command.kind === "start" ? "in_progress" : "unassigned",
      ...(command.kind === "release" ? { reason: command.reason } : {}),
    }, "PATCH");
  }
  if (!photo) throw new Error("The saved cleanup photo is unavailable. Keep the submission for review.");
  const body = new FormData();
  body.append("command_id", command.command_id);
  body.append("expected_version", String(command.expected_version));
  body.append("photo", photo, command.photoUri?.split("/").pop() ?? "cleanup.jpg");
  return api.request<Job>(`/jobs/${encodeURIComponent(command.resource_id)}/completion`, { method: "POST", body });
}
