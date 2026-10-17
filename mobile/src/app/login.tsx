// app/login.tsx — Log in (frontend only: any email/password is accepted)
import { useRef, useState } from "react";
import { View, StyleSheet, type TextInputInstance } from "react-native";
import { router } from "expo-router";

import { AppText, Button, IconButton, Screen, ScreenHeader, SegmentedControl, TextField } from "@/components/ui";
import { signIn, type Role } from "@/auth/session";
import { Layout, Spacing } from "@/theme";

const ROLES: { value: Role; label: string }[] = [
  { value: "resident", label: "Resident" },
  { value: "admin", label: "Admin" },
];

export default function Login() {
  const [role, setRole] = useState<Role>("resident");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<TextInputInstance>(null);

  const canLogIn = email.trim().length > 0 && password.length > 0;

  // Credentials belong to one role, so switching roles starts the form over
  const switchRole = (next: Role) => {
    if (next === role) return;
    setRole(next);
    setEmail("");
    setPassword("");
  };

  const logIn = () => {
    if (!canLogIn) return;
    // TODO: real authentication; the role will come from the account, not this toggle
    signIn({ email: email.trim(), role });
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
      <ScreenHeader title="Log in" subtitle="Track cleanups in your city. Admins can plan crew routes." />

      <SegmentedControl options={ROLES} value={role} onChange={switchRole} />

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
});
