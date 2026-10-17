import { useFonts } from "expo-font";
import { PlusJakartaSans_400Regular } from "@expo-google-fonts/plus-jakarta-sans/400Regular";
import { PlusJakartaSans_500Medium } from "@expo-google-fonts/plus-jakarta-sans/500Medium";
import { PlusJakartaSans_600SemiBold } from "@expo-google-fonts/plus-jakarta-sans/600SemiBold";
import { PlusJakartaSans_700Bold } from "@expo-google-fonts/plus-jakarta-sans/700Bold";

import { Fonts } from "./typography";

// Imported per weight so only these four files are bundled
const FONT_FILES = {
  [Fonts.regular]: PlusJakartaSans_400Regular,
  [Fonts.medium]: PlusJakartaSans_500Medium,
  [Fonts.semibold]: PlusJakartaSans_600SemiBold,
  [Fonts.bold]: PlusJakartaSans_700Bold,
};

/** True once the app fonts are ready (or failed to load, in which case text falls back to the system font). */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(FONT_FILES);
  return loaded || !!error;
}
