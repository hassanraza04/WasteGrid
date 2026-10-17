// app/(tabs)/stats.tsx — Report statistics for the user's city, or any city they search for
import { useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";

import { AppText, Card, Screen, ScreenHeader, SegmentedControl } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { CitySearch } from "@/components/city/city-search";
import { CityHeading } from "@/components/city/city-heading";
import { NoCity } from "@/components/city/no-city";
import { StatCard } from "@/components/stats/stat-card";
import { ReportRow } from "@/components/reports/report-row";
import { useCityPicker } from "@/hooks/use-city-picker";
import { useCityStats, type CityStatsResult } from "@/hooks/use-city-stats";
import type { StatsPeriod } from "@/data/stats";
import { formatDuration } from "@/utils/format";
import { Colors, Spacing } from "@/theme";

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export default function Stats() {
  const { local, city, isLocal, canGoBackToLocal, selectCity, backToLocal } = useCityPicker();
  const [period, setPeriod] = useState<StatsPeriod>("7d");
  const { data, loading } = useCityStats(city, period);

  return (
    <Screen>
      <ScreenHeader title="Statistics" subtitle="Illustrative figures — live statistics are not connected." trailing={<AccountButton />} />
      <CitySearch onSelect={selectCity} />

      {city ? (
        <>
          <CityHeading city={city} isLocal={isLocal} onBackToLocal={canGoBackToLocal ? backToLocal : undefined} />
          <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} />
          {data ? <CityStatsView data={data} updating={loading} /> : <ActivityIndicator color={Colors.ink} style={s.loading} />}
        </>
      ) : (
        <NoCity local={local} />
      )}
    </Screen>
  );
}

// Labels come from `data`, not the current selection: while `updating`, the figures are still the previous
// city/period's, so they're dimmed and keep their own labels until the new ones arrive.
function CityStatsView({ data: { city, period, stats }, updating }: { data: CityStatsResult; updating: boolean }) {
  const periodLabel = PERIODS.find((p) => p.value === period)?.label;
  const reports = stats.recentReports;

  return (
    <View style={[s.statsBody, updating && s.stale]} accessibilityState={{ busy: updating }}>
      <View style={s.cards}>
        <StatCard icon="check-circle" label="Reports resolved" value={String(stats.reportsResolved)} highlight />
        <View style={s.cardRow}>
          <StatCard icon="flag" label="Reports made" value={String(stats.reportsMade)} style={s.flex} />
          <StatCard
            icon="clock"
            label="Avg. time to resolve"
            value={stats.avgHoursToResolve === null ? "–" : formatDuration(stats.avgHoursToResolve)}
            style={s.flex}
          />
        </View>
      </View>

      <View style={s.sectionHeader}>
        <AppText variant="title">Recent reports</AppText>
        <View style={s.headerMeta}>
          {updating && <ActivityIndicator size="small" color={Colors.ink} />}
          <AppText variant="caption" tone="muted">{city.name} · last {periodLabel}</AppText>
        </View>
      </View>
      <Card padding={Spacing.lg} style={s.listCard}>
        {reports.length === 0
          ? <AppText tone="muted" style={s.empty}>No reports in {city.name} in the last {periodLabel}.</AppText>
          : reports.map((r, i) => <ReportRow key={r.id} report={r} divider={i < reports.length - 1} />)}
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  statsBody: { gap: Spacing.lg },
  stale: { opacity: 0.5 },
  headerMeta: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  cards: { gap: Spacing.md },
  cardRow: { flexDirection: "row", gap: Spacing.md },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: Spacing.sm },
  listCard: { paddingVertical: Spacing.xs },
  empty: { paddingVertical: Spacing.md },
  loading: { marginTop: Spacing.xxl },
});
