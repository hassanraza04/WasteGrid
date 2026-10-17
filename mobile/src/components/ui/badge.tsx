import { View, StyleSheet } from "react-native";

import { AppText } from "@/components/ui/text";
import { Radius, Spacing, Tones, type Tone } from "@/theme";

type Props = { label: string; tone?: Tone };

// Small tinted pill for a status, e.g. "In progress"
export function Badge({ label, tone = "neutral" }: Props) {
  const { fg, bg } = Tones[tone];
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <View style={[s.dot, { backgroundColor: fg }]} />
      <AppText variant="micro" style={{ color: fg }}>{label}</AppText>
    </View>
  );
}

const s = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: Spacing.xs + 2,
           paddingHorizontal: Spacing.sm + 2, paddingVertical: Spacing.xs, borderRadius: Radius.pill },
  dot: { width: 6, height: 6, borderRadius: 3 },
});
