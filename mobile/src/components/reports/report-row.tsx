import { View, StyleSheet } from "react-native";

import { AppText, Badge, ListRow } from "@/components/ui";
import { REPORT_STATUS } from "@/components/reports/status";
import { Spacing } from "@/theme";
import { formatShortDate } from "@/utils/format";
import type { Report } from "@/data/demo-reports";

type Props = {
  report: Pick<Report, "caption" | "address" | "status" | "createdAt">;
  divider?: boolean;
};

// Compact report line without a photo, for lists inside a Card
export function ReportRow({ report, divider }: Props) {
  const status = REPORT_STATUS[report.status];
  return (
    <ListRow
      divider={divider}
      title={report.caption}
      subtitle={report.address}
      footer={
        <View style={s.meta}>
          <Badge label={status.label} tone={status.tone} />
          <AppText variant="caption" tone="muted">{formatShortDate(report.createdAt)}</AppText>
        </View>
      }
    />
  );
}

const s = StyleSheet.create({
  meta: { flexDirection: "row", alignItems: "center", gap: Spacing.sm, marginTop: Spacing.xs },
});
