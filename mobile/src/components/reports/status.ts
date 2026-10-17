import type { Tone } from "@/theme";
import type { ReportStatus } from "@/data/demo-reports";

// How each report status is labelled and colored everywhere it's shown
export const REPORT_STATUS: Record<ReportStatus, { label: string; tone: Tone }> = {
  submitted: { label: "Submitted", tone: "warning" },
  "in-progress": { label: "In progress", tone: "info" },
  resolved: { label: "Resolved", tone: "success" },
};
