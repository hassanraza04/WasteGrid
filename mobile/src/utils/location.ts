import * as Location from "expo-location";

export type Coords = { latitude: number; longitude: number };

export type CoordsResult =
  | { ok: true; coords: Coords }
  | { ok: false; reason: "denied" | "timeout" | "unavailable" };

type CoordsOptions = {
  // Accept a cached fix up to this old (instant) before asking the GPS for a fresh one
  maxCacheAgeMs?: number;
  // How precise the cached fix must be, in metres
  requiredCacheAccuracyM?: number;
  accuracy?: Location.Accuracy;
  // Give up on the fresh GPS read after this long. Doesn't count time spent on the permission prompt.
  timeoutMs?: number;
};

// Every location lookup in the app goes through here: permission, cached/fresh fix, timeout, errors.
export async function getCurrentCoords(options: CoordsOptions = {}): Promise<CoordsResult> {
  const { maxCacheAgeMs, requiredCacheAccuracyM, accuracy = Location.Accuracy.Balanced, timeoutMs } = options;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return { ok: false, reason: "denied" };

    const cached = maxCacheAgeMs
      ? await Location.getLastKnownPositionAsync({ maxAge: maxCacheAgeMs, requiredAccuracy: requiredCacheAccuracyM })
      : null;
    const position = cached ?? (await withTimeout(Location.getCurrentPositionAsync({ accuracy }), timeoutMs));
    if (!position) return { ok: false, reason: "timeout" };

    return { ok: true, coords: { latitude: position.coords.latitude, longitude: position.coords.longitude } };
  } catch {
    return { ok: false, reason: "unavailable" }; // e.g. location services off
  }
}

// Resolves to null if the promise takes longer than `ms`; no limit when `ms` is undefined
function withTimeout<T>(promise: Promise<T>, ms?: number): Promise<T | null> {
  if (ms === undefined) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export type PhotoLocation = {
  coords: Coords | null; // null if the user typed the address by hand
  address: string;
};

// Current position + a readable address. Returns null if permission is denied or location is unavailable.
export async function getPhotoLocation(): Promise<PhotoLocation | null> {
  const result = await getCurrentCoords({
    maxCacheAgeMs: 60_000,
    requiredCacheAccuracyM: 50,
    accuracy: Location.Accuracy.Highest,
  });
  if (!result.ok) return null;

  const [address] = await Location.reverseGeocodeAsync(result.coords).catch(() => []);
  return { coords: result.coords, address: address ? formatAddress(address) : "" };
}

export function formatAddress(address: Location.LocationGeocodedAddress): string {
  const nameOrStreet = address.name ?? address.street;
  const districtOrSubregion = address.district ?? address.subregion;

  const parts = [nameOrStreet, districtOrSubregion, address.city]
    .filter((part): part is string => Boolean(part));

  const uniqueParts = [...new Set(parts)];

  return uniqueParts.join(", ");
}
