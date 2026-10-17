// Account sign-in; staff roles and crew ownership come from the backend.
import { useRef, useState } from "react";
import { View, StyleSheet, type TextInputInstance } from "react-native";
import { router } from "expo-router";

import { AppText, Button, IconButton, Screen, ScreenHeader, TextField } from "@/components/ui";
import { signIn } from "@/auth/session";
import { Layout, Spacing } from "@/theme";

export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const signingIn = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<TextInputInstance>(null);

  const canLogIn = !busy && email.trim().length > 0 && password.length > 0;
  const logIn = async () => {
    if (!canLogIn || signingIn.current) return;
    signingIn.current = true; setBusy(true); setError("");
    try {
      await signIn(email.trim(), password);
      router.back();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to sign in. Please retry.");
    } finally { signingIn.current = false; setBusy(false); }
  };

  return (
    <Screen
      tabBar={false}
      keyboard
      edges={["top", "bottom"]}
      header={
        <View style={s.header}>
          <IconButton icon="x" variant="sunken" size="sm" accessibilityLabel="Close" disabled={busy} onPress={() => router.back()} />
        </View>
      }>
      <ScreenHeader title="Log in" subtitle="Report waste and track cleanups. Crews see their routes; admins plan them." />

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

      <Button label="Log in" onPress={logIn} loading={busy} disabled={!canLogIn} style={s.submit} />
      {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
      <AppText variant="caption" tone="muted">Sign in with your WasteGrid account. Sessions end when the app restarts.</AppText>
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
