import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { Colors, Radius } from "@/theme";

type Props = {
  value: number; // 0–1
  style?: StyleProp<ViewStyle>;
};

// Thin green bar showing how far along something is
export function ProgressBar({ value, style }: Props) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <View style={[s.track, style]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: percent }}>
      <View style={[s.fill, { width: `${percent}%` }]} />
    </View>
  );
}

const s = StyleSheet.create({
  track: { height: 8, borderRadius: Radius.pill, backgroundColor: Colors.surfaceSunken, overflow: "hidden" },
  fill: { height: "100%", borderRadius: Radius.pill, backgroundColor: Colors.primary },
});
