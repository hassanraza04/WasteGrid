import { useEffect, useState } from "react";

import type { City } from "@/data/cities";
import { getCityStats, type CityStats, type StatsPeriod } from "@/data/stats";

// Stats together with the city and period they were loaded for. Label from these, not the current selection,
// because they can lag behind it while new stats load.
export type CityStatsResult = { city: City; period: StatsPeriod; stats: CityStats };

// Stats for a city and period. Keeps showing the previous result while new ones load, so switching doesn't flash;
// `loading` is true while `data` doesn't match the requested city and period yet.
export function useCityStats(city: City | null, period: StatsPeriod): { data: CityStatsResult | null; loading: boolean } {
  const [result, setResult] = useState<CityStatsResult | null>(null);

  useEffect(() => {
    if (!city) return;
    let cancelled = false;
    getCityStats(city, period).then((stats) => {
      if (!cancelled) setResult({ city, period, stats });
    });
    return () => { cancelled = true; };
  }, [city, period]);

  if (!city) return { data: null, loading: false };
  return { data: result, loading: result?.city.id !== city.id || result.period !== period };
}
