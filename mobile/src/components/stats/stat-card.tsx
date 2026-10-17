import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { Feather } from "@expo/vector-icons";

import { AppColors } from "@/constants/theme";

type Props = {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string;
  highlight?: boolean; // the headline number: green and larger
  style?: StyleProp<ViewStyle>;
};

export function StatCard({ icon, label, value, highlight, style }: Props) {
  return (
    <View style={[s.card, style]}>
      <View style={s.labelRow}>
        <Feather name={icon} size={14} color={highlight ? AppColors.primary : AppColors.textMuted} />
        <Text style={s.label}>{label}</Text>
      </View>
      <Text style={[s.value, highlight && s.valueHighlight]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { backgroundColor: AppColors.surface, borderRadius: 16, borderWidth: 1, borderColor: AppColors.border, padding: 16, gap: 6 },
  labelRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: { fontSize: 13, fontWeight: "500", color: AppColors.textMuted },
  value: { fontSize: 26, fontWeight: "700", color: AppColors.text },
  valueHighlight: { fontSize: 40, color: AppColors.primary },
});
