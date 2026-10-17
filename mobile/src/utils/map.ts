import type { Region } from "react-native-maps";

import type { Coords } from "@/utils/location";

// Where the map opens when the user's location isn't available (Karachi)
export const DEFAULT_REGION: Region = { latitude: 24.8138, longitude: 67.03, latitudeDelta: 0.03, longitudeDelta: 0.03 };

// A street-level view centred on `coords`
export function regionAround(coords: Coords, delta = 0.01): Region {
  return { ...coords, latitudeDelta: delta, longitudeDelta: delta };
}

// A string that changes only when the positions do, for effects that shouldn't rerun on a new array of the same points
export function coordsKey(coords: Coords[]): string {
  return coords.map((c) => `${c.latitude},${c.longitude}`).join("|");
}
