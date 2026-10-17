// app/(tabs)/stats.tsx — Cleanup statistics by city/area. Everyone sees the stats; admins can also plan crew routes.
import { useState } from "react";
import { View, ScrollView, StyleSheet } from "react-native";

import { AppText, Button, Card, Chip, Screen, ScreenHeader, SegmentedControl } from "@/components/ui";
import { StatCard } from "@/components/stats/stat-card";
import { CleanupRow } from "@/components/stats/cleanup-row";
import { RoutePlannerOverlay } from "@/components/admin/route-planner-overlay";
import { useSession } from "@/auth/session";
import { AREAS } from "@/data/areas";
import { getAreaStats, type StatsPeriod } from "@/data/stats";
import { getCrews } from "@/data/crews";
import { planCrewRoutes } from "@/utils/route-planner";
import { Layout, Spacing } from "@/theme";

const PERIODS: { value: StatsPeriod; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export default function Stats() {
  const session = useSession();
  const isAdmin = session?.role === "admin";
  const [area, setArea] = useState(AREAS[0]);
  const [period, setPeriod] = useState<StatsPeriod>("7d");
  const [plannerOpen, setPlannerOpen] = useState(false);

  const stats = getAreaStats(area, period);
  const cleanups = stats.recentCleanups;

  return (
    <>
      <Screen>
        <ScreenHeader title="Statistics" subtitle={area.city} />

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.areas} style={s.areasScroll}>
          {AREAS.map((a) => (
            <Chip key={a.id} label={a.name} selected={a.id === area.id} onPress={() => setArea(a)} />
          ))}
        </ScrollView>

        <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} />

        {isAdmin && <Button label="Plan crew routes" icon="navigation" onPress={() => setPlannerOpen(true)} />}

        <View style={s.cards}>
          <StatCard icon="check-circle" label="Reports handled" value={String(stats.reportsHandled)} highlight />
          <View style={s.cardRow}>
            <StatCard icon="alert-circle" label="Still open" value={String(stats.reportsOpen)} style={s.flex} />
            <StatCard icon="clock" label="Avg. time to clean" value={`${stats.avgHoursToClean} h`} style={s.flex} />
          </View>
        </View>

        <AppText variant="title" style={s.sectionTitle}>Recently cleaned</AppText>
        <Card padding={Spacing.lg} style={s.listCard}>
          {cleanups.length === 0
            ? <AppText tone="muted" style={s.empty}>Nothing cleaned in {area.name} yet.</AppText>
            : cleanups.map((c, i) => <CleanupRow key={c.id} cleanup={c} divider={i < cleanups.length - 1} />)}
        </Card>
      </Screen>

      {isAdmin && (
        <RoutePlannerOverlay
          key={area.id} // fresh crew selection per area
          visible={plannerOpen}
          area={area}
          crews={getCrews(area)}
          onClose={() => setPlannerOpen(false)}
          onCalculate={planCrewRoutes}
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  areasScroll: { marginHorizontal: -Layout.screenPadding }, // chips scroll edge to edge
  areas: { paddingHorizontal: Layout.screenPadding, gap: Spacing.sm },
  cards: { gap: Spacing.md },
  cardRow: { flexDirection: "row", gap: Spacing.md },
  sectionTitle: { marginTop: Spacing.sm },
  listCard: { paddingVertical: Spacing.xs },
  empty: { paddingVertical: Spacing.md },
});
