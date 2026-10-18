import type { ReportDraft, Transport } from "./report-client";

export type PhoneUpdateStatus = "queued" | "sending" | "submitted" | "delivered" | "failed" | "uncertain" | "cancelled";
export interface PhoneUpdateReceipt { id: string; status: PhoneUpdateStatus; message: string; created_at: string }
export interface PhoneUpdates { enabled: boolean; phone_label: string | null; latest_request: PhoneUpdateReceipt | null }
export class PhoneUpdatesError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}
export function isDefinitePhoneRejection(error: unknown): boolean {
  return error instanceof PhoneUpdatesError && error.status !== undefined && [401, 403, 404, 409, 422, 429].includes(error.status);
}
const statuses: PhoneUpdateStatus[] = ["queued", "sending", "submitted", "delivered", "failed", "uncertain", "cancelled"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function statusCommand(message: string): "Status" {
  if (message.trim().toLowerCase() !== "status") throw new PhoneUpdatesError('Type "Status" to request a report update. Other messages are not supported here.');
  return "Status";
}
function receipt(value: PhoneUpdateReceipt): PhoneUpdateReceipt {
  if (!value || !uuid.test(value.id) || !statuses.includes(value.status) ||
      typeof value.message !== "string" || !Number.isFinite(Date.parse(value.created_at))) {
    throw new PhoneUpdatesError("Unable to confirm the phone update. Check its status before retrying.");
  }
  return value;
}
async function phoneRequest(draft: ReportDraft, token: string, request: Transport, body?: { command_id: string; message: string; consent: true }) {
  let response: Response;
  try {
    response = await request(`${draft.apiUrl}/reports/${draft.id}/phone-updates`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new PhoneUpdatesError(body ? "The request could not be confirmed. Check delivery status or retry the same request." : "Unable to check phone updates. Please try again.");
  }
  if (!response.ok) {
    const message = ({
      401: "Sign in to the account that saved this report.",
      403: "This device cannot access phone updates for this report.",
      404: "Phone updates are not available for this report.",
      409: "A phone update cannot be requested right now. Check delivery status.",
      422: 'Type "Status" to request a report update.',
      429: "The phone update limit has been reached. Keep tracking this report here.",
      503: "Phone updates are unavailable right now. Keep tracking this report here.",
    } as Record<number, string>)[response.status];
    throw new PhoneUpdatesError(message ?? "Unable to confirm the phone update. Check its status before retrying.", response.status);
  }
  try { return await response.json(); }
  catch { throw new PhoneUpdatesError("Unable to confirm the phone update. Check its status before retrying."); }
}
export async function readPhoneUpdates(draft: ReportDraft, token: string, request: Transport): Promise<PhoneUpdates> {
  const value = await phoneRequest(draft, token, request);
  if (!value || typeof value.enabled !== "boolean" || !(value.phone_label === null || typeof value.phone_label === "string") ||
      (value.enabled && !value.phone_label?.trim()) || !Object.hasOwn(value, "latest_request")) {
    throw new PhoneUpdatesError("Unable to check phone updates. Please try again.");
  }
  if (value.latest_request !== null) receipt(value.latest_request);
  return value;
}
export async function requestPhoneUpdate(draft: ReportDraft, token: string, commandId: string, message: string, request: Transport): Promise<PhoneUpdateReceipt> {
  const normalized = statusCommand(message);
  if (!uuid.test(commandId)) throw new PhoneUpdatesError("The saved request is invalid. Keep tracking this report here.");
  const value = receipt(await phoneRequest(draft, token, request, { command_id: commandId, message: normalized, consent: true }));
  if (value.id !== commandId) throw new PhoneUpdatesError("Unable to match the phone update. Check its status before retrying.");
  return value;
}
