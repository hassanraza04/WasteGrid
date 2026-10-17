import { useRef, useState, type ReactNode } from "react";
import { View, Pressable, Switch, Modal, StyleSheet } from "react-native";
import Animated, { SlideInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText, Button, Chip, Icon, IconButton } from "@/components/ui";
import { Colors, Layout, Radius, Spacing } from "@/theme";
import type { City } from "@/data/cities";
import type { Crew } from "@/data/crews";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { DEFAULT_CONSTRAINTS, type CrewRoute, type RouteConstraints, type RouteRequest } from "@/utils/route-planner";

type Props = {
  visible: boolean;
  city: City;
  crews: Crew[];
  onClose: () => void;
  onCalculate: (request: RouteRequest) => Promise<CrewRoute[]>;
  onAssign: (routes: CrewRoute[]) => Promise<void>; // send the calculated routes to the crews
};

// Admin-only sheet: pick crews in the city, set constraints, calculate one route per crew, then assign them.
// Give it key={city.id} so the crew selection resets when the city changes.
// Rendered in a Modal so it sits above the floating tab bar.
export function RoutePlannerOverlay({ visible, city, crews, onClose, onCalculate, onAssign }: Props) {
  const insets = useSafeAreaInsets();
  const [constraints, setConstraints] = useState(DEFAULT_CONSTRAINTS);
  const [crewIds, setCrewIds] = useState(() => crews.filter((c) => c.onDuty).map((c) => c.id));
  const [routes, setRoutes] = useState<CrewRoute[] | null>(null); // null = not calculated yet
  const calculation = useLatestRequest();
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const busy = calculation.pending || assigning; // inputs are locked while a request uses them

  // The result no longer matches the inputs: clear it and ignore any calculation still in flight
  const resetRoutes = () => {
    calculation.invalidate();
    setRoutes(null);
  };

  const update = (patch: Partial<RouteConstraints>) => {
    setConstraints((prev) => ({ ...prev, ...patch }));
    resetRoutes();
  };

  const toggleCrew = (id: string) => {
    setCrewIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
    resetRoutes();
  };

  const calculate = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setError("");
    try {
      await calculation.run(() => onCalculate({ cityId: city.id, crewIds, constraints }), setRoutes);
    } catch {
      setError("Unable to calculate routes. Please retry.");
    } finally { inFlight.current = false; }
  };

  const assign = async () => {
    if (!routes?.length || inFlight.current) return;
    inFlight.current = true; setAssigning(true); setError("");
    try {
      await onAssign(routes);
      setRoutes(null);
      onClose();
    } catch {
      setError("Unable to confirm assignment. Check crew progress before retrying.");
    } finally {
      inFlight.current = false;
      setAssigning(false);
    }
  };

  const crewName = (id: string) => crews.find((c) => c.id === id)?.name ?? id;

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => { if (!assigning) onClose(); }}>
      <Pressable style={[StyleSheet.absoluteFill, s.backdrop]} disabled={assigning} onPress={onClose} accessibilityLabel="Close route planner" />

      <Animated.View entering={SlideInDown.duration(260)} style={[s.sheet, { paddingBottom: insets.bottom + Spacing.md }]}>
        <View style={s.handle} />
        <View style={s.header}>
          <View style={s.flex}>
            <AppText variant="title">Plan crew routes</AppText>
            <AppText variant="caption" tone="muted">{city.name} · routes start at each crew&apos;s location</AppText>
          </View>
          <IconButton icon="x" variant="sunken" size="sm" accessibilityLabel="Close" disabled={assigning} onPress={onClose} />
        </View>

        <View style={s.section}>
          <AppText variant="label">Crews</AppText>
          {crews.length === 0 ? (
            <AppText variant="caption" tone="muted">No crews in this city.</AppText>
          ) : (
            <View style={s.chips}>
              {crews.map((crew) => (
                <Chip
                  key={crew.id}
                  label={crew.onDuty ? crew.name : `${crew.name} · off duty`}
                  selected={crewIds.includes(crew.id)}
                  disabled={!crew.onDuty || busy}
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
            disabled={busy}
            onChange={(hours) => update({ hours })}
          />
        </Row>

        <Row label="Max stops per crew">
          <Stepper
            value={constraints.maxStopsPerCrew}
            display={String(constraints.maxStopsPerCrew)}
            step={1} min={1} max={25}
            disabled={busy}
            onChange={(maxStopsPerCrew) => update({ maxStopsPerCrew })}
          />
        </Row>

        <Row label="Return to start" last>
          <Switch
            value={constraints.returnToStart}
            onValueChange={(returnToStart) => update({ returnToStart })}
            disabled={busy}
            trackColor={{ true: Colors.primary, false: Colors.outline }}
            thumbColor={Colors.surface}
          />
        </Row>

        {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
        {routes && (
          <View style={s.result}>
            {routes.length === 0 ? (
              <View style={s.resultRow}>
                <Icon name="map" size={18} color={Colors.primary} />
                <AppText variant="caption" style={s.flex}>Route planning isn&apos;t connected yet. Routes will show here.</AppText>
              </View>
            ) : (
              routes.map((route) => (
                <View key={route.crewId} style={s.resultRow}>
                  <Icon name="truck" size={18} color={Colors.primary} />
                  <AppText variant="caption" style={s.flex}>
                    {crewName(route.crewId)} · {route.stops.length} stops · {route.distanceKm.toFixed(1)} km · {Math.round(route.durationMin)} min
                  </AppText>
                </View>
              ))
            )}
          </View>
        )}

        {routes?.length ? (
          <Button
            label={routes.length === 1 ? "Assign route" : `Assign ${routes.length} routes`}
            icon="send"
            onPress={assign}
            loading={assigning}
            style={s.cta}
          />
        ) : (
          <Button
            label="Calculate routes"
            icon="navigation"
            onPress={calculate}
            loading={calculation.pending}
            disabled={crewIds.length === 0}
            style={s.cta}
          />
        )}
      </Animated.View>
    </Modal>
  );
}

function Row({ label, last, children }: { label: string; last?: boolean; children: ReactNode }) {
  return (
    <View style={[s.row, !last && s.divider]}>
      <AppText variant="label">{label}</AppText>
      {children}
    </View>
  );
}

type StepperProps = { value: number; display: string; step: number; min: number; max: number; disabled?: boolean; onChange: (value: number) => void };

function Stepper({ value, display, step, min, max, disabled, onChange }: StepperProps) {
  return (
    <View style={s.stepper}>
      <IconButton icon="minus" variant="sunken" size="sm" accessibilityLabel="Decrease" disabled={disabled || value <= min} onPress={() => onChange(value - step)} />
      <AppText variant="bodyStrong" align="center" style={s.stepValue}>{display}</AppText>
      <IconButton icon="plus" variant="sunken" size="sm" accessibilityLabel="Increase" disabled={disabled || value >= max} onPress={() => onChange(value + step)} />
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { backgroundColor: Colors.backdrop },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: Colors.surface,
           borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg, paddingHorizontal: Layout.screenPadding, paddingTop: Spacing.sm },
  handle: { alignSelf: "center", width: 40, height: 5, borderRadius: Radius.pill, backgroundColor: Colors.hairline, marginBottom: Spacing.md },
  header: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md, marginBottom: Spacing.sm },
  section: { paddingVertical: Spacing.md, gap: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.hairline },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 60 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.hairline },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
  stepper: { flexDirection: "row", alignItems: "center", gap: Spacing.md },
  stepValue: { minWidth: 44 },
  result: { marginTop: Spacing.md, padding: Spacing.md, gap: Spacing.sm, borderRadius: Radius.sm, backgroundColor: Colors.surfaceSunken },
  resultRow: { flexDirection: "row", alignItems: "center", gap: Spacing.sm },
  cta: { marginTop: Spacing.lg },
});
