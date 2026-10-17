// Transport-only module: shared by native storage and contract tests.
export interface ReportDraft {
  id: string;
  apiUrl: string;
  photoUri: string;
  mime: string;
  fields: Record<string, string>;
  reference?: string;
}

export interface SavedReport {
  id: string;
  public_reference: string;
  title: string;
  display_status: string;
  assessment_status: string;
}

export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

export class ReportApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

function failed(response: Response): never {
  const messages: Record<number, string> = {
    401: "This device cannot access this report.",
    403: "This device cannot access this report.",
    409: "This report was already submitted with different details. Keep this draft and check its status.",
    413: "The photo is too large. The limit is 8 MiB.",
    415: "Use a JPEG, PNG or WebP photo.",
    422: "The report could not be accepted. Check the photo and report details.",
  };
  throw new ReportApiError(messages[response.status] ?? "WasteGrid is unavailable. Keep this draft and retry shortly.", response.status);
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
  if (!response.ok) failed(response);
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
