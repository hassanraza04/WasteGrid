// stats.ts — report statistics per city. Demo data for now.
// TODO: replace getCityStats with a call to the stats API; the screens only depend on the types below.
import type { City } from "@/data/cities";
import type { Report } from "@/data/demo-reports";

export type StatsPeriod = "7d" | "30d";

export type CityReport = Pick<Report, "id" | "caption" | "address" | "status" | "createdAt"> & {
  cityId: string;
  resolvedAt?: string; // ISO date, set once resolved
};

export type CityStats = {
  reportsMade: number; // created in the period
  reportsResolved: number; // resolved in the period
  avgHoursToResolve: number | null; // over reports resolved in the period; null if none were
  recentReports: CityReport[]; // newest first
};

const PERIOD_DAYS: Record<StatsPeriod, number> = { "7d": 7, "30d": 30 };
const RECENT_LIMIT = 8;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export async function getCityStats(city: City, period: StatsPeriod): Promise<CityStats> {
  const since = Date.now() - PERIOD_DAYS[period] * DAY;
  const reports = demoReportsFor(city);

  const made = reports.filter((r) => Date.parse(r.createdAt) >= since);
  const resolved = reports.filter((r) => r.resolvedAt && Date.parse(r.resolvedAt) >= since);
  const totalHours = resolved.reduce((sum, r) => sum + (Date.parse(r.resolvedAt!) - Date.parse(r.createdAt)) / HOUR, 0);

  return {
    reportsMade: made.length,
    reportsResolved: resolved.length,
    avgHoursToResolve: resolved.length ? totalHours / resolved.length : null,
    recentReports: [...made].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, RECENT_LIMIT),
  };
}

// ─── Demo data ───────────────────────────────────────────────────────────────
// A month of made-up reports per city, generated once per city with a fixed seed so the numbers stay put
// between visits. Dates are relative to now so "last 7 days" always has data.

type DemoProfile = { perMonth: number; avgHours: number; neighborhoods: string[] };

const DEMO_PROFILES: Record<string, DemoProfile> = {
  karachi: { perMonth: 240, avgHours: 20, neighborhoods: ["DHA Phase 6", "Clifton", "Saddar", "Gulshan-e-Iqbal", "North Nazimabad", "PECHS"] },
  lahore: { perMonth: 190, avgHours: 16, neighborhoods: ["Gulberg", "DHA Phase 5", "Model Town", "Johar Town", "Anarkali", "Iqbal Town"] },
  islamabad: { perMonth: 80, avgHours: 10, neighborhoods: ["F-7", "G-9", "I-8", "Blue Area", "E-11", "F-10"] },
  rawalpindi: { perMonth: 110, avgHours: 22, neighborhoods: ["Saddar", "Satellite Town", "Bahria Town", "Chaklala"] },
  faisalabad: { perMonth: 90, avgHours: 26, neighborhoods: ["D Ground", "Peoples Colony", "Madina Town", "Susan Road"] },
  multan: { perMonth: 60, avgHours: 28, neighborhoods: ["Cantt", "Gulgasht", "Shah Rukn-e-Alam", "Bosan Road"] },
  peshawar: { perMonth: 85, avgHours: 30, neighborhoods: ["University Town", "Hayatabad", "Saddar", "Gulbahar"] },
  hyderabad: { perMonth: 55, avgHours: 34, neighborhoods: ["Latifabad", "Qasimabad", "Saddar", "Auto Bhan Road"] },
  quetta: { perMonth: 40, avgHours: 40, neighborhoods: ["Jinnah Road", "Satellite Town", "Cantt", "Brewery Road"] },
};

const CAPTIONS = [
  "Overflowing bin next to the bus stop",
  "Dumped bags behind the market",
  "Construction rubble blocking the footpath",
  "Litter along the park fence",
  "Plastic waste in the storm drain",
  "Trash pile burning on an empty plot",
  "Broken furniture left on the street",
  "Food waste outside the restaurants",
  "Debris left after the weekend bazaar",
];

const SPOTS = ["Main Boulevard", "Commercial Area", "Service Road", "Park entrance", "Masjid Road", "School Road", "Food Street"];

const RESOLVE_RATE = 0.85;

const cache = new Map<string, CityReport[]>();

function demoReportsFor(city: City): CityReport[] {
  const cached = cache.get(city.id);
  if (cached) return cached;

  const profile = DEMO_PROFILES[city.id] ?? { perMonth: 0, avgHours: 24, neighborhoods: [] };
  const rand = seededRandom(city.id);
  const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)];
  const now = Date.now();

  const reports = Array.from({ length: profile.perMonth }, (_, i): CityReport => {
    const createdAt = now - rand() * 30 * DAY;
    const resolveAt = createdAt + profile.avgHours * (0.4 + rand() * 1.2) * HOUR;
    const resolved = rand() < RESOLVE_RATE && resolveAt < now;
    return {
      id: `${city.id}-${i}`,
      cityId: city.id,
      caption: pick(CAPTIONS),
      address: `${pick(SPOTS)}, ${pick(profile.neighborhoods)}`,
      status: resolved ? "resolved" : rand() < 0.5 ? "in-progress" : "submitted",
      createdAt: new Date(createdAt).toISOString(),
      resolvedAt: resolved ? new Date(resolveAt).toISOString() : undefined,
    };
  });

  cache.set(city.id, reports);
  return reports;
}

// Small deterministic PRNG (mulberry32) seeded from a string
function seededRandom(seed: string): () => number {
  let a = [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 2654435761), 1779033703);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
