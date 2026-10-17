import { ActivityIndicator, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { Icon, type IconName } from "@/components/ui/icon";
import { Colors, Radius, Shadow, Sizes } from "@/theme";

type Variant = "floating" | "surface" | "sunken" | "scrim" | "plain";

type Props = {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: Variant;
  size?: "md" | "sm";
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

const VARIANTS: Record<Variant, { container: ViewStyle; color: string }> = {
  floating: { container: { backgroundColor: Colors.surface, ...Shadow.floating }, color: Colors.ink }, // over the map
  surface: { container: { backgroundColor: Colors.surface }, color: Colors.ink }, // next to inputs
  sunken: { container: { backgroundColor: Colors.surfaceSunken }, color: Colors.ink }, // inside white cards and sheets
  scrim: { container: { backgroundColor: Colors.scrim }, color: Colors.onDark }, // over photos and the camera
  plain: { container: {}, color: Colors.ink },
};

// Round icon-only button
export function IconButton({ icon, onPress, accessibilityLabel, variant = "floating", size = "md", loading, disabled, style }: Props) {
  const v = VARIANTS[variant];
  const dimension = size === "md" ? Sizes.iconButton : Sizes.iconButtonSm;

  return (
    <PressableScale
      style={[s.base, { width: dimension, height: dimension }, v.container, disabled && s.disabled, style]}
      onPress={onPress}
      disabled={disabled || loading}
      hitSlop={size === "sm" ? 6 : 0}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}>
      {loading
        ? <ActivityIndicator color={v.color} />
        : <Icon name={icon} size={size === "md" ? Sizes.icon : Sizes.iconSm} color={v.color} />}
    </PressableScale>
  );
}

const s = StyleSheet.create({
  base: { borderRadius: Radius.pill, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.4 },
});
