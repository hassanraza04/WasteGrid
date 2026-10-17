import type { Region } from "react-native-maps";

import type { Coords } from "@/utils/location";

// Where the map opens when the user's location isn't available (Karachi)
export const DEFAULT_REGION: Region = { latitude: 24.8138, longitude: 67.03, latitudeDelta: 0.03, longitudeDelta: 0.03 };

// A street-level view centred on `coords`
export function regionAround(coords: Coords, delta = 0.01): Region {
  return { ...coords, latitudeDelta: delta, longitudeDelta: delta };
}
