import { useEffect, useState } from "react";
import type { Region } from "react-native-maps";

import { getCurrentCoords } from "@/utils/location";
import { DEFAULT_REGION, regionAround } from "@/utils/map";

export type StartRegion = {
  region: Region;
  // Location is allowed but GPS was too slow: recenter once the map is ready
  locateLater: boolean;
};

// Where the map should open. null while it's being worked out, so the map can wait
// instead of opening at DEFAULT_REGION and flying across the world to the user.
export function useStartRegion(): StartRegion | null {
  const [start, setStart] = useState<StartRegion | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCurrentCoords({ maxCacheAgeMs: 5 * 60_000, timeoutMs: 3000 }).then((result) => {
      if (cancelled) return;
      setStart(
        result.ok
          ? { region: regionAround(result.coords), locateLater: false }
          : { region: DEFAULT_REGION, locateLater: result.reason === "timeout" },
      );
    });
    return () => { cancelled = true; };
  }, []);

  return start;
}
