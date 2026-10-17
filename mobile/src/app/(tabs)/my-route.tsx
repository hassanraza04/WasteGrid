// app/(tabs)/my-route.tsx — Crew members only: the route their crew has been assigned, stop by stop
import { useState } from "react";
import { Alert, ActivityIndicator, StyleSheet } from "react-native";

import { AppText, Card, EmptyState, ProgressBar, Screen, ScreenHeader } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { RouteMap } from "@/components/route/route-map";
import { StopRow } from "@/components/route/stop-row";
import { useSession } from "@/auth/session";
import { useCrewAssignment } from "@/hooks/use-assignments";
import { countCleaned, setStopCleaned, type Assignment } from "@/data/assignments";
import { getCrew } from "@/data/crews";
import { formatDuration, formatShortDate } from "@/utils/format";
import { Colors, Spacing } from "@/theme";

export default function MyRoute() {
  const session = useSession();
  const crew = session?.crewId ? getCrew(session.crewId) : undefined;
  const assignment = useCrewAssignment(session?.crewId);

  return (
    <Screen>
      <ScreenHeader title="My route" subtitle={crew?.name} trailing={<AccountButton />} />

      {assignment === undefined ? (
        <ActivityIndicator color={Colors.ink} style={s.loading} />
      ) : assignment === null ? (
        <EmptyState
          icon="navigation"
          title="No route assigned yet"
          message="When an admin assigns your crew a route, its stops show up here."
          style={s.empty}
        />
      ) : (
        <AssignedRoute assignment={assignment} />
      )}
    </Screen>
  );
}

function AssignedRoute({ assignment }: { assignment: Assignment }) {
  const [savingStop, setSavingStop] = useState<string | null>(null);
  const cleaned = countCleaned(assignment);
  const total = assignment.stops.length;
  const done = cleaned === total;

  const toggle = async (reportId: string, isCleaned: boolean) => {
    setSavingStop(reportId);
    try {
      await setStopCleaned(assignment.id, reportId, !isCleaned);
    } catch {
      Alert.alert("Couldn't update the stop", "Check your connection and try again.");
    } finally {
      setSavingStop(null);
    }
  };

  return (
    <>
      <RouteMap stops={assignment.stops} />

      <Card style={s.progress}>
        <AppText variant="headline">{done ? "Route complete" : `${cleaned} of ${total} cleaned`}</AppText>
        <ProgressBar value={total ? cleaned / total : 0} />
        <AppText variant="caption" tone="muted">
          {assignment.distanceKm.toFixed(1)} km · about {formatDuration(assignment.durationMin / 60)} · assigned {formatShortDate(assignment.assignedAt)}
        </AppText>
      </Card>

      <AppText variant="title" style={s.sectionTitle}>Stops</AppText>
      <Card padding={Spacing.lg} style={s.listCard}>
        {assignment.stops.map((stop, i) => (
          <StopRow
            key={stop.reportId}
            stop={stop}
            index={i}
            divider={i < total - 1}
            saving={savingStop === stop.reportId}
            onToggleCleaned={() => toggle(stop.reportId, !!stop.cleanedAt)}
          />
        ))}
      </Card>
    </>
  );
}

const s = StyleSheet.create({
  loading: { marginTop: Spacing.xxl },
  empty: { marginTop: Spacing.xxxl },
  progress: { gap: Spacing.md },
  sectionTitle: { marginTop: Spacing.sm },
  listCard: { paddingVertical: Spacing.xs },
});
