export interface OrganizerDiagnostic {
  operation: string;
  status: number | null;
  durationMs: number;
  category:
    "ok" | "timeout" | "network" | "access" | "http" | "invalid_response";
}
const diagnostics: OrganizerDiagnostic[] = [];
// Deliberately excludes URL, query, body, credentials, report text and location.
export function recordDiagnostic(
  operation: string,
  status: number | null,
  duration: number,
  category: OrganizerDiagnostic["category"],
) {
  diagnostics.push({
    operation,
    status,
    durationMs: Math.round(duration),
    category,
  });
  if (diagnostics.length > 40) diagnostics.shift();
}
export function organizerDiagnostics(): readonly OrganizerDiagnostic[] {
  return diagnostics.map((item) => ({ ...item }));
}
