import { View, StyleSheet } from "react-native";
import { Image } from "expo-image";

import { AppText, Badge, Card, Icon, ListRow } from "@/components/ui";
import { REPORT_STATUS } from "@/components/reports/status";
import { Colors, Radius, Spacing } from "@/theme";
import { formatShortDate } from "@/utils/format";
import type { Report } from "@/data/demo-reports";

// One report in the list: photo, caption, address, status and date
export function ReportCard({ report }: { report: Report }) {
  const status = REPORT_STATUS[report.status];

  return (
    <Card padding={Spacing.md}>
      <ListRow
        style={s.row}
        leading={report.photoUri
          ? <Image source={{ uri: report.photoUri }} style={s.thumb} contentFit="cover" />
          : <View style={[s.thumb, s.thumbEmpty]}><Icon name="trash-2" color={Colors.inkMuted} /></View>}
        title={report.caption}
        titleLines={2}
        subtitle={report.address}
        footer={
          <View style={s.meta}>
            <Badge label={status.label} tone={status.tone} />
            <AppText variant="caption" tone="muted">{formatShortDate(report.createdAt)} · {report.id}</AppText>
          </View>
        }
      />
    </Card>
  );
}

const s = StyleSheet.create({
  row: { paddingVertical: 0, alignItems: "flex-start" },
  thumb: { width: 76, height: 76, borderRadius: Radius.sm },
  thumbEmpty: { backgroundColor: Colors.surfaceSunken, alignItems: "center", justifyContent: "center" },
  meta: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, marginTop: Spacing.xs },
});
