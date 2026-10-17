import { useEffect, useState } from "react";

import { searchCities, type City } from "@/data/cities";

// Cities matching `query`. Ignores results that come back after the query has changed.
export function useCitySearch(query: string): City[] {
  const [results, setResults] = useState<{ query: string; cities: City[] }>({ query: "", cities: [] });

  useEffect(() => {
    let cancelled = false;
    searchCities(query).then((cities) => {
      if (!cancelled) setResults({ query, cities });
    });
    return () => { cancelled = true; };
  }, [query]);

  return results.query === query ? results.cities : [];
}
