import { useState, type ReactNode } from "react";
import { View, Text, Pressable, Switch, ActivityIndicator, StyleSheet } from "react-native";
import Animated, { FadeIn, FadeOut, SlideInDown, SlideOutDown } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { PressableScale } from "@/components/ui/pressable-scale";
import { Chip } from "@/components/ui/chip";
import { AppColors } from "@/constants/theme";
import type { Area } from "@/data/areas";
import type { Crew } from "@/data/crews";
import { DEFAULT_CONSTRAINTS, type CrewRoute, type RouteConstraints, type RouteRequest } from "@/utils/route-planner";

type Props = {
  visible: boolean;
  area: Area;
  crews: Crew[];
  onClose: () => void;
  onCalculate: (request: RouteRequest) => Promise<CrewRoute[]>;
};

// Admin-only sheet: pick crews in the area, set constraints, then calculate one route per crew.
// Give it key={area.id} so the crew selection resets when the area changes.
export function RoutePlannerOverlay({ visible, area, crews, onClose, onCalculate }: Props) {
  const [constraints, setConstraints] = useState(DEFAULT_CONSTRAINTS);
  const [crewIds, setCrewIds] = useState(() => crews.filter((c) => c.onDuty).map((c) => c.id));
  const [routes, setRoutes] = useState<CrewRoute[] | null>(null); // null = not calculated yet
  const [calculating, setCalculating] = useState(false);

  if (!visible) return null;

  const update = (patch: Partial<RouteConstraints>) => {
    setConstraints((prev) => ({ ...prev, ...patch }));
    setRoutes(null); // result no longer matches the inputs
  };

  const toggleCrew = (id: string) => {
    setCrewIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
    setRoutes(null);
  };

  const calculate = async () => {
    setCalculating(true);
    try {
      setRoutes(await onCalculate({ areaId: area.id, crewIds, constraints }));
    } finally {
      setCalculating(false);
    }
  };

  const crewName = (id: string) => crews.find((c) => c.id === id)?.name ?? id;

  // Fragment, not a wrapper View: the exit animations only run if these Animated.Views are what unmounts
  return (
    <>
      <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(200)} style={[StyleSheet.absoluteFill, s.backdrop]}>
        <Pressable style={s.flex} onPress={onClose} accessibilityLabel="Close route planner" />
      </Animated.View>

      <Animated.View entering={SlideInDown.duration(260)} exiting={SlideOutDown.duration(200)} style={s.sheet}>
        <SafeAreaView edges={["bottom"]}>
          <View style={s.handle} />
          <View style={s.header}>
            <View>
              <Text style={s.title}>Plan crew routes</Text>
              <Text style={s.subtitle}>{area.name} · routes start at each crew&apos;s location</Text>
            </View>
            <PressableScale onPress={onClose} hitSlop={12}><Feather name="x" size={24} color={AppColors.text} /></PressableScale>
          </View>

          <View style={s.section}>
            <Text style={s.rowLabel}>Crews</Text>
            {crews.length === 0 ? (
              <Text style={s.muted}>No crews in this area.</Text>
            ) : (
              <View style={s.chips}>
                {crews.map((crew) => (
                  <Chip
                    key={crew.id}
                    label={crew.onDuty ? crew.name : `${crew.name} · off duty`}
                    selected={crewIds.includes(crew.id)}
                    disabled={!crew.onDuty}
                    onPress={() => toggleCrew(crew.id)}
                  />
                ))}
              </View>
            )}
          </View>

          <Row label="Time available">
            <Stepper
              value={constraints.hours}
              display={`${constraints.hours} h`}
              step={0.5} min={0.5} max={8}
              onChange={(hours) => update({ hours })}
            />
          </Row>

          <Row label="Max stops per crew">
            <Stepper
              value={constraints.maxStopsPerCrew}
              display={String(constraints.maxStopsPerCrew)}
              step={1} min={1} max={25}
              onChange={(maxStopsPerCrew) => update({ maxStopsPerCrew })}
            />
          </Row>

          <Row label="Return to start">
            <Switch
              value={constraints.returnToStart}
              onValueChange={(returnToStart) => update({ returnToStart })}
              trackColor={{ true: AppColors.primary, false: AppColors.border }}
            />
          </Row>

          {routes && (
            <View style={s.result}>
              {routes.length === 0 ? (
                <View style={s.resultRow}>
                  <Feather name="map" size={18} color={AppColors.accent} />
                  <Text style={s.resultText}>Route planning isn&apos;t connected yet. Routes will show here.</Text>
                </View>
              ) : (
                routes.map((route) => (
                  <View key={route.crewId} style={s.resultRow}>
                    <Feather name="truck" size={18} color={AppColors.accent} />
                    <Text style={s.resultText}>
                      {crewName(route.crewId)} · {route.stops.length} stops · {route.distanceKm.toFixed(1)} km · {Math.round(route.durationMin)} min
                    </Text>
                  </View>
                ))
              )}
            </View>
          )}

          <PressableScale
            haptic="medium"
            style={[s.cta, (crewIds.length === 0 || calculating) && s.disabled]}
            onPress={calculate}
            disabled={crewIds.length === 0 || calculating}>
            {calculating ? <ActivityIndicator color={AppColors.onPrimary} /> : <Feather name="navigation" size={18} color={AppColors.onPrimary} />}
            <Text style={s.ctaText}>Calculate routes</Text>
          </PressableScale>
        </SafeAreaView>
      </Animated.View>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      {children}
    </View>
  );
}

type StepperProps = { value: number; display: string; step: number; min: number; max: number; onChange: (value: number) => void };

function Stepper({ value, display, step, min, max, onChange }: StepperProps) {
  return (
    <View style={s.stepper}>
      <PressableScale style={[s.stepBtn, value <= min && s.disabled]} disabled={value <= min} onPress={() => onChange(value - step)} hitSlop={6}>
        <Feather name="minus" size={16} color={AppColors.text} />
      </PressableScale>
      <Text style={s.stepValue}>{display}</Text>
      <PressableScale style={[s.stepBtn, value >= max && s.disabled]} disabled={value >= max} onPress={() => onChange(value + step)} hitSlop={6}>
        <Feather name="plus" size={16} color={AppColors.text} />
      </PressableScale>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { backgroundColor: AppColors.backdrop },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: AppColors.surface,
           borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 8 },
  handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: AppColors.border, marginBottom: 12 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 },
  title: { fontSize: 20, fontWeight: "700", color: AppColors.text },
  subtitle: { fontSize: 14, color: AppColors.textMuted, marginTop: 2 },
  section: { paddingVertical: 12, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AppColors.border },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 56,
         borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: AppColors.border },
  rowLabel: { fontSize: 15, fontWeight: "500", color: AppColors.text },
  muted: { fontSize: 14, color: AppColors.textMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: AppColors.background, borderWidth: 1, borderColor: AppColors.border,
             alignItems: "center", justifyContent: "center" },
  stepValue: { minWidth: 44, textAlign: "center", fontSize: 16, fontWeight: "600", color: AppColors.text },
  result: { marginTop: 16, padding: 12, gap: 10, borderRadius: 12, backgroundColor: AppColors.background },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  resultText: { flex: 1, fontSize: 14, color: AppColors.text },
  cta: { marginTop: 16, marginBottom: 12, height: 56, borderRadius: 16, backgroundColor: AppColors.primary,
         flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  ctaText: { color: AppColors.onPrimary, fontSize: 17, fontWeight: "600" },
  disabled: { opacity: 0.4 },
});
