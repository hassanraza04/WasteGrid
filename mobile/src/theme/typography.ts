import type { TextStyle } from "react-native";

/**
 * Plus Jakarta Sans, one family name per weight. Android can't pick a weight of a custom font
 * through `fontWeight`, so styles set `fontFamily` instead. Loaded in `useAppFonts()`.
 */
export const Fonts = {
  regular: "PlusJakartaSans_400Regular",
  medium: "PlusJakartaSans_500Medium",
  semibold: "PlusJakartaSans_600SemiBold",
  bold: "PlusJakartaSans_700Bold",
} as const;

/** The type scale. Render text with <AppText variant="…"> rather than using these directly. */
export const Type = {
  display: { fontFamily: Fonts.semibold, fontSize: 32, lineHeight: 38, letterSpacing: -0.8 }, // screen headlines
  stat: { fontFamily: Fonts.bold, fontSize: 40, lineHeight: 46, letterSpacing: -1 }, // big numbers
  headline: { fontFamily: Fonts.semibold, fontSize: 24, lineHeight: 30, letterSpacing: -0.5 }, // card headlines
  title: { fontFamily: Fonts.semibold, fontSize: 19, lineHeight: 24, letterSpacing: -0.3 }, // sheet and section titles
  bodyStrong: { fontFamily: Fonts.semibold, fontSize: 16, lineHeight: 22, letterSpacing: -0.1 }, // list row titles
  body: { fontFamily: Fonts.medium, fontSize: 16, lineHeight: 22 },
  label: { fontFamily: Fonts.semibold, fontSize: 15, lineHeight: 20 }, // buttons, chips, form labels
  caption: { fontFamily: Fonts.medium, fontSize: 13, lineHeight: 18 },
  micro: { fontFamily: Fonts.semibold, fontSize: 12, lineHeight: 16 }, // tab labels, badges
} as const satisfies Record<string, TextStyle>;

export type TypeVariant = keyof typeof Type;
