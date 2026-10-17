// demo-reports.ts — placeholder reports until the report API exists
// (statuses match web/src/domain/reports.ts)
import type { Coords } from "@/utils/location";

export type ReportStatus = "submitted" | "in-progress" | "resolved";

export type Report = {
  id: string;
  caption: string;
  address: string;
  coords: Coords;
  status: ReportStatus;
  createdAt: string; // ISO date
  photoUri?: string;
};

export const DEMO_REPORTS: Report[] = [
  {
    id: "WG-1042",
    caption: "Overflowing bin next to the bus stop",
    address: "Khayaban-e-Ittehad, DHA Phase 6",
    coords: { latitude: 24.8091, longitude: 67.0402 },
    status: "submitted",
    createdAt: "2026-10-17T08:15:00.000Z",
  },
  {
    id: "WG-1038",
    caption: "Dumped bags behind the market",
    address: "Bukhari Commercial, DHA Phase 6",
    coords: { latitude: 24.8159, longitude: 67.0327 },
    status: "in-progress",
    createdAt: "2026-10-16T16:40:00.000Z",
  },
  {
    id: "WG-1031",
    caption: "Construction rubble blocking the footpath",
    address: "Zamzama Boulevard, Clifton",
    coords: { latitude: 24.8205, longitude: 67.0289 },
    status: "submitted",
    createdAt: "2026-10-16T09:05:00.000Z",
  },
  {
    id: "WG-1019",
    caption: "Litter along the park fence",
    address: "Beach Avenue Park, DHA Phase 8",
    coords: { latitude: 24.8046, longitude: 67.0251 },
    status: "resolved",
    createdAt: "2026-10-14T11:30:00.000Z",
  },
];
