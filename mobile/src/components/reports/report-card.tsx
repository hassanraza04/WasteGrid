import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { Feather } from "@expo/vector-icons";

import { AppColors } from "@/constants/theme";
import type { Report, ReportStatus } from "@/data/demo-reports";

const STATUS: Record<ReportStatus, { label: string; color: string }> = {
  submitted: { label: "Submitted", color: AppColors.statusSubmitted },
  "in-progress": { label: "In progress", color: AppColors.statusInProgress },
  resolved: { label: "Resolved", color: AppColors.statusResolved },
};

// One row in the reports list: photo, caption, address, status and date
export function ReportCard({ report }: { report: Report }) {
  const status = STATUS[report.status];
  const date = new Date(report.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <View style={s.card}>
      {report.photoUri ? (
        <Image source={{ uri: report.photoUri }} style={s.thumb} contentFit="cover" />
      ) : (
        <View style={[s.thumb, s.thumbEmpty]}><Feather name="trash-2" size={22} color={AppColors.textMuted} /></View>
      )}

      <View style={s.info}>
        <Text style={s.caption} numberOfLines={2}>{report.caption}</Text>
        <Text style={s.address} numberOfLines={1}>{report.address}</Text>
        <View style={s.meta}>
          <View style={[s.dot, { backgroundColor: status.color }]} />
          <Text style={[s.status, { color: status.color }]}>{status.label}</Text>
          <Text style={s.date}>· {date} · {report.id}</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { flexDirection: "row", gap: 12, padding: 12, backgroundColor: AppColors.surface, borderRadius: 16,
          borderWidth: 1, borderColor: AppColors.border },
  thumb: { width: 72, height: 72, borderRadius: 12 },
  thumbEmpty: { backgroundColor: AppColors.background, alignItems: "center", justifyContent: "center" },
  info: { flex: 1, gap: 4 },
  caption: { fontSize: 15, fontWeight: "600", color: AppColors.text },
  address: { fontSize: 13, color: AppColors.textMuted },
  meta: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 13, fontWeight: "600" },
  date: { fontSize: 13, color: AppColors.textMuted },
});
