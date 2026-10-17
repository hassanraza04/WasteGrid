import { ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppText } from "@/components/ui/text";
import { Icon, type IconName } from "@/components/ui/icon";
import { Colors, Radius, Shadow, Sizes, Spacing } from "@/theme";
import type { HapticStrength } from "@/utils/haptics";

type Variant = "primary" | "secondary" | "outline" | "ghost";
type Size = "lg" | "md";

type Props = {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  loading?: boolean; // shows a spinner in place of the icon and blocks presses
  disabled?: boolean;
  haptic?: HapticStrength | "none";
  style?: StyleProp<ViewStyle>;
};

const VARIANTS: Record<Variant, { container: ViewStyle; color: string; tone: "inverse" | "default" | "primary" }> = {
  primary: { container: { backgroundColor: Colors.primary }, color: Colors.onPrimary, tone: "inverse" },
  secondary: { container: { backgroundColor: Colors.surface, ...Shadow.sm }, color: Colors.ink, tone: "default" },
  outline: { container: { borderWidth: 1.5, borderColor: Colors.outline }, color: Colors.ink, tone: "default" },
  ghost: { container: {}, color: Colors.primary, tone: "primary" },
};

// Primary = the one main action on a screen. Secondary = white button on grey or over photos.
// Outline = other actions inside cards. Ghost = inline text actions.
export function Button({ label, onPress, variant = "primary", size = "lg", icon, loading, disabled, haptic, style }: Props) {
  const v = VARIANTS[variant];
  const inactive = disabled || loading;

  return (
    <PressableScale
      haptic={haptic ?? (variant === "primary" ? "medium" : "light")}
      style={[s.base, s[size], variant === "ghost" && s.ghost, v.container, inactive && s.disabled, style]}
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}>
      {loading
        ? <ActivityIndicator size="small" color={v.color} />
        : icon && <Icon name={icon} size={size === "lg" ? 20 : Sizes.iconSm} color={v.color} />}
      <AppText variant="label" tone={v.tone} style={size === "lg" && s.labelLg}>{label}</AppText>
    </PressableScale>
  );
}

const s = StyleSheet.create({
  base: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Spacing.sm, borderRadius: Radius.md },
  lg: { height: Sizes.control, paddingHorizontal: Spacing.xxl },
  md: { height: Sizes.controlSm, paddingHorizontal: Spacing.lg },
  ghost: { height: undefined, paddingHorizontal: 0, gap: Spacing.xs },
  labelLg: { fontSize: 16 },
  disabled: { opacity: 0.4 },
});
