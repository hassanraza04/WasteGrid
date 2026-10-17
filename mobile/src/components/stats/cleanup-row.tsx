import { View, Text, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";

import { AppColors } from "@/constants/theme";
import type { Cleanup } from "@/data/stats";

// One line in "Recently cleaned"
export function CleanupRow({ cleanup }: { cleanup: Cleanup }) {
  const date = new Date(cleanup.cleanedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <View style={s.row}>
      <View style={s.icon}><Feather name="check" size={16} color={AppColors.onPrimary} /></View>
      <View style={s.info}>
        <Text style={s.caption} numberOfLines={1}>{cleanup.caption}</Text>
        <Text style={s.address} numberOfLines={1}>{cleanup.address}</Text>
      </View>
      <Text style={s.date}>{date}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12,
         borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AppColors.border },
  icon: { width: 30, height: 30, borderRadius: 15, backgroundColor: AppColors.primary, alignItems: "center", justifyContent: "center" },
  info: { flex: 1, gap: 2 },
  caption: { fontSize: 15, fontWeight: "600", color: AppColors.text },
  address: { fontSize: 13, color: AppColors.textMuted },
  date: { fontSize: 13, color: AppColors.textMuted },
});
