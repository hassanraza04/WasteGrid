// app/(tabs)/reports.tsx — My reports tab. Logged out: a prompt to log in.
import { View, Text, FlatList, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";

import { PressableScale } from "@/components/ui/pressable-scale";
import { ReportCard } from "@/components/reports/report-card";
import { useSession } from "@/auth/session";
import { DEMO_REPORTS } from "@/data/demo-reports";
import { AppColors } from "@/constants/theme";

export default function Reports() {
  const session = useSession();

  if (!session) {
    return (
      <SafeAreaView style={[s.container, s.signedOut]}>
        <Feather name="file-text" size={40} color={AppColors.textMuted} />
        <Text style={s.signedOutTitle}>Log in to see your reports</Text>
        <Text style={s.signedOutText}>Track the waste you&apos;ve reported and see when it&apos;s cleaned up.</Text>
        <PressableScale haptic="medium" style={s.loginBtn} onPress={() => router.push("/login")}>
          <Text style={s.loginText}>Log in</Text>
        </PressableScale>
      </SafeAreaView>
    );
  }

  // TODO: the signed-in user's own reports, once the report API exists
  const reports = DEMO_REPORTS;
  const openCount = reports.filter((r) => r.status !== "resolved").length;

  return (
    <View style={s.container}>
      <SafeAreaView edges={["top"]} style={s.flex}>
        <FlatList
          data={reports}
          keyExtractor={(r) => r.id}
          renderItem={({ item }) => <ReportCard report={item} />}
          contentContainerStyle={s.list}
          ListHeaderComponent={
            <View style={s.intro}>
              <Text style={s.title}>My reports</Text>
              <Text style={s.subtitle}>{session.email} · {openCount} open</Text>
            </View>
          }
          ListEmptyComponent={<Text style={s.empty}>No reports yet. Reports you submit will show up here.</Text>}
        />
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: AppColors.background },
  signedOut: { alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  signedOutTitle: { fontSize: 20, fontWeight: "700", color: AppColors.text, marginTop: 4 },
  signedOutText: { fontSize: 15, color: AppColors.textMuted, textAlign: "center" },
  loginBtn: { marginTop: 8, height: 52, paddingHorizontal: 40, borderRadius: 16, backgroundColor: AppColors.primary,
              alignItems: "center", justifyContent: "center" },
  loginText: { color: AppColors.onPrimary, fontSize: 17, fontWeight: "600" },
  list: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 12 },
  intro: { marginBottom: 8, gap: 4 },
  title: { fontSize: 28, fontWeight: "700", color: AppColors.text },
  subtitle: { fontSize: 14, color: AppColors.textMuted },
  empty: { fontSize: 15, color: AppColors.textMuted, textAlign: "center", marginTop: 48 },
});
