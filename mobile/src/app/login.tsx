// app/login.tsx — Log in (frontend only: any email/password is accepted)
import { useRef, useState } from "react";
import { View, StyleSheet, type TextInputInstance } from "react-native";
import { router } from "expo-router";

import { AppText, Button, Chip, IconButton, Screen, ScreenHeader, SegmentedControl, TextField } from "@/components/ui";
import { ROLES } from "@/components/account/roles";
import { signIn, type Role } from "@/auth/session";
import { getAllCrews } from "@/data/crews";
import { Layout, Spacing } from "@/theme";

export default function Login() {
  const [role, setRole] = useState<Role>("user");
  const [crewId, setCrewId] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<TextInputInstance>(null);

  const canLogIn = email.trim().length > 0 && password.length > 0 && (role !== "crew" || !!crewId);

  // Credentials belong to one role, so switching roles starts the form over
  const switchRole = (next: Role) => {
    if (next === role) return;
    setRole(next);
    setCrewId(null);
    setEmail("");
    setPassword("");
  };

  const logIn = () => {
    if (!canLogIn) return;
    // TODO: real authentication; the role and crew will come from the account, not these pickers
    signIn({ email: email.trim(), role, crewId: role === "crew" ? crewId! : undefined });
    router.back(); // back to wherever Log in was opened from
  };

  return (
    <Screen
      tabBar={false}
      keyboard
      edges={["top", "bottom"]}
      header={
        <View style={s.header}>
          <IconButton icon="x" variant="sunken" size="sm" accessibilityLabel="Close" onPress={() => router.back()} />
        </View>
      }>
      <ScreenHeader title="Log in" subtitle="Report waste and track cleanups. Crews see their routes; admins plan them." />

      <SegmentedControl options={ROLES} value={role} onChange={switchRole} />

      {role === "crew" && (
        <View style={s.crewPicker}>
          <AppText variant="label" style={s.crewLabel}>Your crew</AppText>
          <View style={s.crews}>
            {getAllCrews().map((crew) => (
              <Chip key={crew.id} label={crew.name} selected={crew.id === crewId} onPress={() => setCrewId(crew.id)} />
            ))}
          </View>
        </View>
      )}

      <TextField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
      />

      <TextField
        ref={passwordRef}
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="••••••••"
        secureTextEntry
        autoComplete="password"
        returnKeyType="go"
        onSubmitEditing={logIn}
      />

      <Button label="Log in" onPress={logIn} disabled={!canLogIn} style={s.submit} />
      <AppText variant="caption" tone="muted" align="center">Demo: any email and password will work.</AppText>
    </Screen>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", paddingHorizontal: Layout.screenPadding, paddingTop: Spacing.md },
  submit: { marginTop: Spacing.sm },
  crewPicker: { gap: Spacing.sm },
  crewLabel: { paddingHorizontal: Spacing.xs },
  crews: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
});
