import * as Location from "expo-location";

export type PhotoLocation = {
  coords: { latitude: number; longitude: number } | null; // null if the user typed the address by hand
  address: string;
};

// Current position + a readable address. Returns null if permission is denied or location is unavailable.
export async function getPhotoLocation(): Promise<PhotoLocation | null> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return null;

  try {
    // A recent cached fix is instant; fall back to a fresh GPS read (can take a few seconds)
    const position =
      (await Location.getLastKnownPositionAsync({ maxAge: 60_000, requiredAccuracy: 50 })) ??
      (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }));
    const coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    const [address] = await Location.reverseGeocodeAsync(coords).catch(() => []);
    return { coords, address: address ? formatAddress(address) : "" };
  } 
  catch {
    return null;
  }
}

export function formatAddress(address: Location.LocationGeocodedAddress): string {
  const nameOrStreet = address.name ?? address.street;
  const districtOrSubregion = address.district ?? address.subregion;

  const parts = [nameOrStreet, districtOrSubregion, address.city]
    .filter((part): part is string => Boolean(part));

  const uniqueParts = [...new Set(parts)];

  return uniqueParts.join(", ");
}