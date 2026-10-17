import { useEffect, useState, type RefObject } from "react";
import type MapView from "react-native-maps";
import type { EdgePadding } from "react-native-maps";

import { coordsKey } from "@/utils/map";
import type { Coords } from "@/utils/location";

// Keeps a map framed on `coords`: fits once the map is ready, then again whenever the positions change.
// Returns the handler to pass as the MapView's onMapReady.
export function useFitToCoordinates(mapRef: RefObject<MapView | null>, coords: Coords[], edgePadding: EdgePadding) {
  const [ready, setReady] = useState(false);
  const key = coordsKey(coords);

  useEffect(() => {
    if (!ready || coords.length === 0) return;
    mapRef.current?.fitToCoordinates(coords, { edgePadding, animated: false });
    // Keyed on the positions rather than array identity, so re-renders with the same stops leave the camera alone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);

  return () => setReady(true);
}
