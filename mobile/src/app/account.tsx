// app/account.tsx — Account sheet, opened from the avatar on any tab: who's signed in, and log out
import { Alert, View, StyleSheet } from "react-native";
import { router } from "expo-router";

import { Avatar, Badge, Button, Card, IconButton, ListRow, Screen } from "@/components/ui";
import { roleInfo } from "@/components/account/roles";
import { signOut, useSession } from "@/auth/session";
import { getCrew } from "@/data/crews";
import { Layout, Spacing } from "@/theme";

export default function Account() {
  const session = useSession();

  const close = () => router.back();

  const confirmSignOut = () =>
    Alert.alert("Log out?", session ? `You're signed in as ${session.email}.` : undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: () => { signOut(); close(); } },
    ]);

  const role = session && roleInfo(session.role);
  const crew = session?.crewId ? getCrew(session.crewId) : undefined;

  return (
    <Screen
      tabBar={false}
      edges={["top", "bottom"]}
      header={
        <View style={s.header}>
          <IconButton icon="x" variant="sunken" size="sm" accessibilityLabel="Close" onPress={close} />
        </View>
      }>
      {session && role ? (
        <>
          <Card>
            <ListRow
              leading={<Avatar name={session.email} />}
              title={session.email}
              footer={<View style={s.badges}>
                <Badge label={role.label} tone={role.tone} />
                {crew && <Badge label={crew.name} />}
              </View>}
            />
          </Card>
          <Button label="Log out" icon="log-out" variant="outline" onPress={confirmSignOut} />
        </>
      ) : (
        <Button label="Log in" onPress={() => router.replace("/login")} />
      )}
    </Screen>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", paddingHorizontal: Layout.screenPadding, paddingTop: Spacing.md },
  badges: { flexDirection: "row", gap: Spacing.sm, marginTop: Spacing.xs },
});
