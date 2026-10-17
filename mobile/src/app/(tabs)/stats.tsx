// app/(tabs)/stats.tsx — Cleanup statistics by city/area. Everyone sees the stats; admins can also plan crew routes.
import { useState } from "react";
import { View, Text, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { PressableScale } from "@/components/ui/pressable-scale";
import { Chip } from "@/components/ui/chip";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatCard } from "@/components/stats/stat-card";
import { CleanupRow } from "@/components/stats/cleanup-row";
import { RoutePlannerOverlay } from "@/components/admin/route-planner-overlay";
import { useSession } from "@/auth/session";
import { AREAS } from "@/data/areas";
import { getAreaStats, type StatsPeriod } from "@/data/stats";
import { getCrews } from "@/data/crews";
import { planCrewRoutes } from "@/utils/route-planner";
import { AppColors } from "@/constants/theme";

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

  return (
    <View style={s.container}>
      <SafeAreaView edges={["top"]} style={s.flex}>
        <ScrollView contentContainerStyle={[s.content, isAdmin && s.contentWithCta]}>
          <Text style={s.title}>Statistics</Text>
          <Text style={s.subtitle}>{area.city}</Text>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.areas} style={s.areasScroll}>
            {AREAS.map((a) => (
              <Chip key={a.id} label={a.name} selected={a.id === area.id} onPress={() => setArea(a)} />
            ))}
          </ScrollView>

          <SegmentedControl options={PERIODS} value={period} onChange={setPeriod} style={s.period} />

          <StatCard icon="check-circle" label="Reports handled" value={String(stats.reportsHandled)} highlight />
          <View style={s.cardRow}>
            <StatCard icon="alert-circle" label="Still open" value={String(stats.reportsOpen)} style={s.flex} />
            <StatCard icon="clock" label="Avg. time to clean" value={`${stats.avgHoursToClean} h`} style={s.flex} />
          </View>

          <Text style={s.sectionTitle}>Recently cleaned</Text>
          {stats.recentCleanups.length === 0
            ? <Text style={s.empty}>Nothing cleaned in {area.name} yet.</Text>
            : stats.recentCleanups.map((c) => <CleanupRow key={c.id} cleanup={c} />)}
        </ScrollView>
      </SafeAreaView>

      {isAdmin && (
        <>
          <PressableScale haptic="medium" style={s.cta} onPress={() => setPlannerOpen(true)}>
            <Feather name="navigation" size={20} color={AppColors.onPrimary} />
            <Text style={s.ctaText}>Plan crew routes</Text>
          </PressableScale>

          <RoutePlannerOverlay
            key={area.id} // fresh crew selection per area
            visible={plannerOpen}
            area={area}
            crews={getCrews(area)}
            onClose={() => setPlannerOpen(false)}
            onCalculate={planCrewRoutes}
          />
        </>
      )}
    </View>
  );
}

const shadow = { elevation: 4, shadowColor: AppColors.shadow, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } };
const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: AppColors.background },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  contentWithCta: { paddingBottom: 120 }, // room to scroll past the floating button
  title: { fontSize: 28, fontWeight: "700", color: AppColors.text },
  subtitle: { fontSize: 15, color: AppColors.textMuted, marginTop: -8 },
  areasScroll: { marginHorizontal: -16 }, // chips scroll edge to edge
  areas: { paddingHorizontal: 16, gap: 8 },
  period: { marginBottom: 4 },
  cardRow: { flexDirection: "row", gap: 12 },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: AppColors.text, marginTop: 12 },
  empty: { fontSize: 15, color: AppColors.textMuted },
  cta: { position: "absolute", left: 24, right: 24, bottom: 32, height: 64, borderRadius: 16, backgroundColor: AppColors.primary,
         flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, ...shadow },
  ctaText: { color: AppColors.onPrimary, fontSize: 17, fontWeight: "600" },
});
