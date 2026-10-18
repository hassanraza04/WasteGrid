import type { ViewStyle } from "react-native";

/** Spacing scale for padding, margins and gaps. */
export const Spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const Radius = {
  sm: 12, // thumbnails, inset boxes
  md: 20, // buttons, inputs
  lg: 28, // cards and sheets
  pill: 999, // chips, badges, tab bar, round buttons
} as const;

/** Soft, wide shadows. `boxShadow` renders the same on iOS and Android, unlike `elevation`. */
export const Shadow = {
  sm: { boxShadow: "0 1px 3px rgba(15, 20, 26, 0.10)" },
  card: { boxShadow: "0 6px 24px rgba(15, 20, 26, 0.06)" },
  floating: { boxShadow: "0 8px 28px rgba(15, 20, 26, 0.14)" },
} as const satisfies Record<string, ViewStyle>;

/** Fixed sizes shared across components. */
export const Sizes = {
  control: 56, // primary buttons
  controlSm: 44, // segmented control, small buttons
  input: 52,
  iconButton: 48,
  iconButtonSm: 36,
  icon: 22,
  iconSm: 18,
  mapPicker: 360,
  tabBar: 68,
} as const;

export const Layout = {
  screenPadding: Spacing.xl, // left/right padding on every screen
  tabBarGap: Spacing.sm, // space between the floating tab bar and the bottom inset
} as const;
