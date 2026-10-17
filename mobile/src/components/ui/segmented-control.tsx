import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppColors } from "@/constants/theme";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
};

// iOS-style switch between a few options, e.g. Resident / Admin or 7 days / 30 days
export function SegmentedControl<T extends string>({ options, value, onChange, style }: Props<T>) {
  return (
    <View style={[s.track, style]}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <PressableScale key={option.value} style={[s.segment, selected && s.segmentActive]} onPress={() => onChange(option.value)}>
            <Text style={[s.text, selected && s.textActive]}>{option.label}</Text>
          </PressableScale>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  track: { flexDirection: "row", backgroundColor: AppColors.border, borderRadius: 12, padding: 4 },
  segment: { flex: 1, height: 36, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  segmentActive: { backgroundColor: AppColors.surface, elevation: 1, shadowColor: AppColors.shadow, shadowOpacity: 0.08, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
  text: { fontSize: 15, fontWeight: "500", color: AppColors.textMuted },
  textActive: { color: AppColors.text, fontWeight: "600" },
});
