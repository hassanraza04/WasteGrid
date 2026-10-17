import { useEffect, useState } from "react";
import * as Location from "expo-location";

import { findCityNear, type City } from "@/data/cities";
import { getCurrentCoords } from "@/utils/location";

export type LocalCity =
  | { status: "locating" }
  | { status: "found"; city: City }
  | { status: "unsupported"; placeName: string | null } // located, but we have no data for that place
  | { status: "unavailable" }; // permission denied, GPS timed out or location is off

// The city the user is in, worked out once from their location
export function useLocalCity(): LocalCity {
  const [local, setLocal] = useState<LocalCity>({ status: "locating" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getCurrentCoords({ maxCacheAgeMs: 10 * 60_000, timeoutMs: 5000 });
      const city = result.ok ? findCityNear(result.coords) : null;

      let next: LocalCity;
      if (!result.ok) next = { status: "unavailable" };
      else if (city) next = { status: "found", city };
      else {
        // Name the place so the screen can say what we don't have data for
        const [place] = await Location.reverseGeocodeAsync(result.coords).catch(() => []);
        next = { status: "unsupported", placeName: place?.city ?? place?.subregion ?? null };
      }
      if (!cancelled) setLocal(next);
    })();
    return () => { cancelled = true; };
  }, []);

  return local;
}
