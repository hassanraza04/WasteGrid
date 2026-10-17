// app/(tabs)/account.tsx — Who's signed in, and log in / log out
import { Alert, StyleSheet } from "react-native";
import { router } from "expo-router";

import { Avatar, Badge, Button, Card, EmptyState, ListRow, Screen, ScreenHeader } from "@/components/ui";
import { signOut, useSession } from "@/auth/session";

export default function Account() {
  const session = useSession();

  if (!session) {
    return (
      <Screen contentStyle={s.center}>
        <EmptyState
          icon="user"
          title="Log in to WasteGrid"
          message="Track the waste you've reported and see when it's cleaned up."
          action={<Button label="Log in" onPress={() => router.push("/login")} />}
        />
      </Screen>
    );
  }

  const confirmSignOut = () =>
    Alert.alert("Log out?", `You're signed in as ${session.email}.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: signOut },
    ]);

  return (
    <Screen>
      <ScreenHeader title="Account" />
      <Card>
        <ListRow
          leading={<Avatar name={session.email} />}
          title={session.email}
          footer={<Badge label={session.role === "admin" ? "Admin" : "Resident"} tone={session.role === "admin" ? "info" : "success"} />}
        />
      </Card>
      <Button label="Log out" icon="log-out" variant="outline" onPress={confirmSignOut} />
    </Screen>
  );
}

const s = StyleSheet.create({
  center: { flexGrow: 1, justifyContent: "center" },
});
