// stats.ts — cleanup statistics per area. Demo numbers for now.
// TODO: replace getAreaStats with a call to the stats API; the screens only depend on the types below.
import { isInArea, type Area } from "@/data/areas";

export type StatsPeriod = "7d" | "30d";

export type Cleanup = {
  id: string;
  areaId: string;
  caption: string;
  address: string;
  cleanedAt: string; // ISO date
};

export type AreaStats = {
  reportsHandled: number;
  reportsOpen: number;
  avgHoursToClean: number;
  recentCleanups: Cleanup[];
};

type Totals = Omit<AreaStats, "recentCleanups">;

const DEMO_TOTALS: Record<string, Record<StatsPeriod, Totals>> = {
  karachi: { "7d": { reportsHandled: 128, reportsOpen: 41, avgHoursToClean: 19 }, "30d": { reportsHandled: 512, reportsOpen: 41, avgHoursToClean: 23 } },
  dha:     { "7d": { reportsHandled: 47, reportsOpen: 9, avgHoursToClean: 14 },   "30d": { reportsHandled: 186, reportsOpen: 9, avgHoursToClean: 17 } },
  clifton: { "7d": { reportsHandled: 52, reportsOpen: 14, avgHoursToClean: 18 },  "30d": { reportsHandled: 201, reportsOpen: 14, avgHoursToClean: 21 } },
  saddar:  { "7d": { reportsHandled: 29, reportsOpen: 18, avgHoursToClean: 31 },  "30d": { reportsHandled: 125, reportsOpen: 18, avgHoursToClean: 34 } },
};

const DEMO_CLEANUPS: Cleanup[] = [
  { id: "WG-1036", areaId: "dha", caption: "Overflowing bin next to the bus stop", address: "Khayaban-e-Ittehad, DHA Phase 6", cleanedAt: "2026-10-17T07:20:00.000Z" },
  { id: "WG-1029", areaId: "clifton", caption: "Construction rubble on the footpath", address: "Zamzama Boulevard, Clifton", cleanedAt: "2026-10-16T15:05:00.000Z" },
  { id: "WG-1024", areaId: "saddar", caption: "Dumped bags behind the market", address: "Empress Market, Saddar", cleanedAt: "2026-10-16T10:45:00.000Z" },
  { id: "WG-1019", areaId: "dha", caption: "Litter along the park fence", address: "Beach Avenue Park, DHA Phase 8", cleanedAt: "2026-10-15T12:30:00.000Z" },
  { id: "WG-1011", areaId: "clifton", caption: "Overflowing bins at the seafront", address: "Sea View, Clifton", cleanedAt: "2026-10-14T18:10:00.000Z" },
];

export function getAreaStats(area: Area, period: StatsPeriod): AreaStats {
  return {
    ...(DEMO_TOTALS[area.id]?.[period] ?? { reportsHandled: 0, reportsOpen: 0, avgHoursToClean: 0 }),
    recentCleanups: DEMO_CLEANUPS.filter((c) => isInArea(c.areaId, area)),
  };
}
