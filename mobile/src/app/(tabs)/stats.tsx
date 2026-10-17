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
import { useCityStats } from "@/hooks/use-city-stats";
import type { City } from "@/data/cities";
import type { CityStats, StatsPeriod } from "@/data/stats";
import { formatDuration } from "@/utils/format";
import { Colors, Spacing } from "@/theme";

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export default function Stats() {
  const { local, city, isLocal, canGoBackToLocal, selectCity, backToLocal } = useCityPicker();
  const [period, setPeriod] = useState<StatsPeriod>("7d");
  const { stats } = useCityStats(city, period);

  return (
    <Screen>
      <ScreenHeader title="Statistics" trailing={<AccountButton />} />
      <CitySearch onSelect={selectCity} />

      {city ? (
        <>
          <CityHeading city={city} isLocal={isLocal} onBackToLocal={canGoBackToLocal ? backToLocal : undefined} />
          <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} />
          {stats ? <CityStatsView city={city} stats={stats} period={period} /> : <ActivityIndicator color={Colors.ink} style={s.loading} />}
        </>
      ) : (
        <NoCity local={local} />
      )}
    </Screen>
  );
}

function CityStatsView({ city, stats, period }: { city: City; stats: CityStats; period: StatsPeriod }) {
  const periodLabel = PERIODS.find((p) => p.value === period)?.label;
  const reports = stats.recentReports;

  return (
    <>
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
        <AppText variant="caption" tone="muted">Last {periodLabel}</AppText>
      </View>
      <Card padding={Spacing.lg} style={s.listCard}>
        {reports.length === 0
          ? <AppText tone="muted" style={s.empty}>No reports in {city.name} in the last {periodLabel}.</AppText>
          : reports.map((r, i) => <ReportRow key={r.id} report={r} divider={i < reports.length - 1} />)}
      </Card>
    </>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  cards: { gap: Spacing.md },
  cardRow: { flexDirection: "row", gap: Spacing.md },
  sectionHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginTop: Spacing.sm },
  listCard: { paddingVertical: Spacing.xs },
  empty: { paddingVertical: Spacing.md },
  loading: { marginTop: Spacing.xxl },
});
