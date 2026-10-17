// Transport-only module: shared by native storage and contract tests.
export interface ReportDraft {
  id: string;
  apiUrl: string;
  photoUri: string;
  mime: string;
  fields: Record<string, string>;
  reference?: string;
  ownerId?: string;
  rejection?: string;
}

export interface SavedReport {
  id: string;
  public_reference: string;
  title: string;
  display_status: string;
  assessment_status: string;
  photo_id?: string;
  completion_photo_ids?: string[];
}

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

export class ReportApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function failed(response: Response, upload = false): never {
  const messages: Record<number, string> = {
    401: "This device cannot access this report.",
    403: "This device cannot access this report.",
    409: "This report was already submitted with different details. Keep this draft and check its status.",
    413: "Use a photo smaller than 8 MiB and no larger than 25 megapixels.",
    415: "Use a JPEG, PNG or WebP photo.",
    422: "The report could not be accepted. Check the photo and report details.",
  };
  const ErrorType = upload && [413, 415, 422].includes(response.status) ? ReportRejectedError : ReportApiError;
  throw new ErrorType(messages[response.status] ?? "WasteGrid is unavailable. Keep this draft and retry shortly.", response.status);
}

export async function readReport(draft: ReportDraft, token: string, request: Transport): Promise<SavedReport | null> {
  const response = await request(`${draft.apiUrl}/reports/${draft.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000), redirect: "error",
  });
  if (response.status === 404) return null;
  if (!response.ok) failed(response);
  const report: SavedReport = await response.json();
  if (report.id !== draft.id) throw new Error("Unexpected report response. Keep your saved draft.");
  return report;
}

export async function uploadReport(
  draft: ReportDraft, token: string, photo: Blob, request: Transport,
): Promise<SavedReport> {
  // Recover an accepted upload after a lost response before sending bytes again.
  const existing = await readReport(draft, token, request);
  if (existing) return existing;
  const body = new FormData();
  body.append("client_report_id", draft.id);
  Object.entries(draft.fields).forEach(([key, value]) => body.append(key, value));
  body.append("photo", photo, draft.photoUri.split("/").pop());
  const response = await request(`${draft.apiUrl}/reports`, {
    method: "POST", headers: { "X-Report-Token": token }, body,
    signal: AbortSignal.timeout(90_000), redirect: "error",
  });
  if (!response.ok) failed(response, true);
  const result: { report: SavedReport } = await response.json();
  if (result.report.id !== draft.id) throw new Error("Unexpected report response. Keep your saved draft.");
  return result.report;
}

export function residentToken(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "wg_r_", buffer = 0, bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; output += alphabet[(buffer >>> bits) & 63]; }
  }
  if (bits) output += alphabet[(buffer << (6 - bits)) & 63];
  return output;
}

export function reportFields(caption: string, location: { coords: { latitude: number; longitude: number } | null; address: string } | null): Record<string, string> {
  const note = caption.trim();
  const address = location?.address.trim() ?? "";
  if (!note) throw new Error("Add a caption before submitting.");
  if (address.length > 500) throw new Error("Keep the address to 500 characters or fewer.");
  if (!location?.coords && !address) throw new Error("Enter an address or use your current location.");
  return {
    title: note.slice(0, 160), note,
    ...(address ? { address } : {}),
    ...(location?.coords ? { latitude: String(location.coords.latitude), longitude: String(location.coords.longitude) } : {}),
  };
}

// Only validation failures from POST establish that these bytes were rejected.
// Errors from the recovery GET, conflicts and timeouts must preserve the draft.
export class ReportRejectedError extends ReportApiError {}

export async function sendSavedDraft(
  draft: ReportDraft, token: string, photo: Blob, request: Transport,
  save: (draft: ReportDraft) => Promise<void>,
): Promise<SavedReport> {
  try {
    const report = await uploadReport(draft, token, photo, request);
    const { rejection: _rejection, ...saved } = draft;
    await save({ ...saved, reference: report.public_reference });
    return report;
  } catch (error) {
    if (error instanceof ReportRejectedError) await save({ ...draft, rejection: error.message });
    throw error;
  }
}

export async function discardRejectedDraft(
  draft: ReportDraft, token: string, request: Transport, remove: () => Promise<void>,
): Promise<void> {
  if (!draft.rejection || draft.reference) throw new Error("Only a rejected upload can be discarded. Check this report's status first.");
  const existing = await readReport(draft, token, request);
  if (existing) throw new Error("WasteGrid has accepted this report. Refresh its status instead of discarding it.");
  await remove();
}

export interface ReportUpdate {
  id: string;
  created_at: string;
  message: string;
  status: string | null;
}
export interface UpdatePage { items: ReportUpdate[]; limit: number; offset: number; total: number }
export interface PhotoAccess { url: string; expiresAt: number }

export async function readReportUpdates(draft: ReportDraft, token: string, offset: number, request: Transport): Promise<UpdatePage> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history page.");
  const response = await request(`${draft.apiUrl}/reports/${draft.id}/updates?limit=50&offset=${offset}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000), redirect: "error",
  });
  if (!response.ok) failed(response);
  const page: UpdatePage = await response.json();
  if (!Array.isArray(page.items) || page.offset !== offset || page.limit !== 50 || !Number.isSafeInteger(page.total) || page.total < 0) {
    throw new Error("Unable to read report history. Please refresh.");
  }
  return page;
}

export async function readPhotoAccess(draft: ReportDraft, token: string, photoId: string, request: Transport): Promise<PhotoAccess> {
  const requestedAt = Date.now();
  const response = await request(`${draft.apiUrl}/photos/${encodeURIComponent(photoId)}/access`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000), redirect: "error",
  });
  if (!response.ok) failed(response);
  const access = await response.json();
  if (typeof access.url !== "string" || !access.url.startsWith("https://") ||
      !Number.isFinite(access.expires_in) || access.expires_in <= 0) throw new Error("Unable to load this private photo.");
  return { url: access.url, expiresAt: requestedAt + access.expires_in * 1000 };
}
