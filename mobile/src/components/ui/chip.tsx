import { StyleSheet } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppText } from "@/components/ui/text";
import { Icon, type IconName } from "@/components/ui/icon";
import { Colors, Radius, Sizes, Spacing } from "@/theme";

type Props = {
  label: string;
  selected: boolean;
  onPress: () => void;
  icon?: IconName;
  disabled?: boolean;
};

// Outlined pill toggle, e.g. an area filter or a crew to include. Selected = filled ink.
export function Chip({ label, selected, onPress, icon, disabled }: Props) {
  const color = selected ? Colors.onPrimary : Colors.ink;
  return (
    <PressableScale
      style={[s.chip, selected && s.selected, disabled && s.disabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}>
      {icon && <Icon name={icon} size={Sizes.iconSm} color={color} />}
      <AppText variant="label" style={{ color }}>{label}</AppText>
    </PressableScale>
  );
}

const s = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, height: 40, paddingHorizontal: Spacing.lg,
          borderRadius: Radius.pill, borderWidth: 1.5, borderColor: Colors.outline },
  selected: { backgroundColor: Colors.ink, borderColor: Colors.ink },
  disabled: { opacity: 0.4 },
});
