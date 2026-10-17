import * as Location from "expo-location";

export type PhotoLocation = {
  coords: { latitude: number; longitude: number } | null; // null if the user typed the address by hand
  address: string;
};

// Current position + a readable address. Returns null if permission is denied or location is unavailable.
export async function getPhotoLocation(): Promise<PhotoLocation | null> {
  // TODO: requestForegroundPermissionsAsync → getCurrentPositionAsync → reverseGeocodeAsync
  return null;
}

// e.g. "Clifton Block 5, Karachi"
export function formatAddress(address: Location.LocationGeocodedAddress): string {
  // TODO: join name/street, district, city — skipping nulls and duplicates
  return "";
}
