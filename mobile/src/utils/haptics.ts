// haptics.ts — one place to tune (or turn off) every tap the app makes
import * as Haptics from "expo-haptics";

export type HapticStrength = "light" | "medium" | "heavy";

const ENABLED = true;

const styles: Record<HapticStrength, Haptics.ImpactFeedbackStyle> = {
  light: Haptics.ImpactFeedbackStyle.Light,   // regular buttons
  medium: Haptics.ImpactFeedbackStyle.Medium, // main actions
  heavy: Haptics.ImpactFeedbackStyle.Heavy,   // camera shutter
};

export function tap(strength: HapticStrength = "light") {
  if (!ENABLED) return;
  Haptics.impactAsync(styles[strength]).catch(() => {}); // unsupported device → silently skip
}
