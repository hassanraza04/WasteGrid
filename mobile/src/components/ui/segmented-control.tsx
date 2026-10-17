import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppText } from "@/components/ui/text";
import { Colors, Radius, Shadow, Sizes, Spacing } from "@/theme";

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
};

// Pill switch between a few options, e.g. Resident / Admin or 7 days / 30 days
export function SegmentedControl<T extends string>({ options, value, onChange, style }: Props<T>) {
  return (
    <View style={[s.track, style]} accessibilityRole="tablist">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <PressableScale
            key={option.value}
            style={[s.segment, selected && s.segmentActive]}
            onPress={() => onChange(option.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}>
            <AppText variant="label" tone={selected ? "default" : "muted"}>{option.label}</AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  track: { flexDirection: "row", backgroundColor: Colors.surfaceSunken, borderRadius: Radius.pill, padding: Spacing.xs },
  segment: { flex: 1, height: Sizes.controlSm - Spacing.xs * 2, borderRadius: Radius.pill, alignItems: "center", justifyContent: "center" },
  segmentActive: { backgroundColor: Colors.surface, ...Shadow.sm },
});
