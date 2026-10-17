// secure-random.ts — the two expo-crypto calls the app needs, backed by expo-modules-core's native uuidv4
// (Android: java.util.UUID.randomUUID, which uses SecureRandom; iOS: Foundation UUID). That generator ships
// in Expo Go and every build. expo-crypto >=58.0.5 doesn't register its main module on Android, so importing
// it crashes there with "Cannot find native module 'ExpoCrypto'" (expo/expo#51198).
import { uuid } from "expo";

const V4 = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
// Byte 6 holds the version nibble and byte 8 the variant bits; the other 14 bytes are uniformly random.
const RANDOM_BYTES = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15];

function v4Hex(): string {
  const hex = uuid.v4().toLowerCase().replaceAll("-", "");
  if (!V4.test(hex)) throw new Error("Secure random generator is unavailable on this device.");
  return hex;
}

export function randomUUID(): string {
  const hex = v4Hex();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function getRandomBytesAsync(length: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const hex = v4Hex();
    for (const i of RANDOM_BYTES) {
      if (filled === length) break;
      bytes[filled++] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
  }
  return bytes;
}
