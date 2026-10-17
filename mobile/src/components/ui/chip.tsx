import { Text, StyleSheet } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppColors } from "@/constants/theme";

type Props = {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
};

// Small pill toggle, e.g. an area filter or a crew to include
export function Chip({ label, selected, onPress, disabled }: Props) {
  return (
    <PressableScale style={[s.chip, selected && s.chipActive, disabled && s.disabled]} onPress={onPress} disabled={disabled}>
      <Text style={[s.text, selected && s.textActive]}>{label}</Text>
    </PressableScale>
  );
}

const s = StyleSheet.create({
  chip: { paddingHorizontal: 14, height: 34, borderRadius: 17, borderWidth: 1, borderColor: AppColors.border,
          backgroundColor: AppColors.surface, justifyContent: "center" },
  chipActive: { backgroundColor: AppColors.accent, borderColor: AppColors.accent },
  text: { fontSize: 14, fontWeight: "500", color: AppColors.text },
  textActive: { color: AppColors.onPrimary },
  disabled: { opacity: 0.4 },
});
