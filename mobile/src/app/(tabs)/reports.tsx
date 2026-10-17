// app/(tabs)/reports.tsx — My reports tab. Logged out: a prompt to log in.
import { FlatList, StyleSheet } from "react-native";
import { router } from "expo-router";

import { Button, EmptyState, Screen, ScreenHeader, useScreenPadding } from "@/components/ui";
import { ReportCard } from "@/components/reports/report-card";
import { useSession } from "@/auth/session";
import { DEMO_REPORTS } from "@/data/demo-reports";
import { Spacing } from "@/theme";

export default function Reports() {
  const session = useSession();
  const padding = useScreenPadding();

  if (!session) {
    return (
      <Screen contentStyle={s.center}>
        <EmptyState
          icon="file-text"
          title="Log in to see your reports"
          message="Track the waste you've reported and see when it's cleaned up."
          action={<Button label="Log in" onPress={() => router.push("/login")} />}
        />
      </Screen>
    );
  }

  // TODO: the signed-in user's own reports, once the report API exists
  const reports = DEMO_REPORTS;
  const openCount = reports.filter((r) => r.status !== "resolved").length;

  return (
    <Screen scroll={false}>
      <FlatList
        data={reports}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <ReportCard report={item} />}
        contentContainerStyle={[padding, s.list]}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={<ScreenHeader title="My reports" subtitle={`${openCount} open · ${session.email}`} style={s.header} />}
        ListEmptyComponent={<EmptyState icon="inbox" title="No reports yet" message="Reports you submit will show up here." style={s.empty} />}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  center: { flexGrow: 1, justifyContent: "center" },
  list: { gap: Spacing.md },
  header: { marginBottom: Spacing.sm },
  empty: { marginTop: Spacing.xxxl },
});
