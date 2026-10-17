import { useEffect, useState } from "react";

import type { City } from "@/data/cities";
import { getCityStats, type CityStats, type StatsPeriod } from "@/data/stats";

// Never label data from one city or period as another.
export function useCityStats(city: City | null, period: StatsPeriod): { stats: CityStats | null; loading: boolean } {
  const [result, setResult] = useState<{ key: string; stats: CityStats } | null>(null);
  const key = city ? `${city.id}:${period}` : null;

  useEffect(() => {
    if (!city) return;
    let cancelled = false;
    getCityStats(city, period).then((stats) => {
      if (!cancelled) setResult({ key: `${city.id}:${period}`, stats });
    });
    return () => { cancelled = true; };
  }, [city, period]);

  if (!key) return { stats: null, loading: false };
  return { stats: result?.key === key ? result.stats : null, loading: result?.key !== key };
}
