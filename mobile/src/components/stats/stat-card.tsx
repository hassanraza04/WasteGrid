import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { AppText, Card, Icon, type IconName } from "@/components/ui";
import { Colors, Sizes, Spacing } from "@/theme";

type Props = {
  icon: IconName;
  label: string;
  value: string;
  highlight?: boolean; // the headline number: green and larger
  style?: StyleProp<ViewStyle>;
};

export function StatCard({ icon, label, value, highlight, style }: Props) {
  return (
    <Card style={[s.card, style]}>
      <View style={s.labelRow}>
        <Icon name={icon} size={Sizes.iconSm} color={highlight ? Colors.primary : Colors.inkMuted} />
        <AppText variant="caption" tone="muted">{label}</AppText>
      </View>
      <AppText variant={highlight ? "stat" : "headline"} tone={highlight ? "primary" : "default"}>{value}</AppText>
    </Card>
  );
}

const s = StyleSheet.create({
  card: { gap: Spacing.sm },
  labelRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
});
