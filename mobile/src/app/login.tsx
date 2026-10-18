// Account sign-in; staff roles and crew ownership come from the backend.
import { useEffect, useRef, useState } from "react";
import { View, StyleSheet, Platform, Image, type TextInputInstance } from "react-native";
import { router, usePreventRemove } from "expo-router";

import { AppText, Button, IconButton, Screen, ScreenHeader, TextField } from "@/components/ui";
import { signIn, useAuthBusy } from "@/auth/session";
import { Layout, Spacing } from "@/theme";

export default function Login() {
  const busy = useAuthBusy();
  const disablePrevention = usePreventRemove(busy);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [error, setError] = useState("");
  const signingIn = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const passwordRef = useRef<TextInputInstance>(null);

  const canLogIn = !busy && email.trim().length > 0 && password.length > 0;
  const logIn = async () => {
    if (!canLogIn || signingIn.current) return;
    signingIn.current = true; setError("");
    try {
      await signIn(email.trim(), password);
      if (mounted.current) {
        // The global operation has settled; bypass the previous render's native
        // removal guard before React commits the now-idle snapshot.
        disablePrevention();
        router.back();
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Unable to sign in. Please retry.");
    } finally { signingIn.current = false; }
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
      <Image
        source={require("@/assets/images/wastegrid-logo.png")}
        style={s.brand}
        resizeMode="contain"
        accessible
        accessibilityLabel="WasteGrid"
      />
      <ScreenHeader title="Log in" subtitle="Report waste and track cleanups. Crews see their routes; admins plan them." />

      <TextField
        label="Email"
        editable={!busy}
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
        editable={!busy}
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
      <AppText variant="caption" tone="muted">Sign in with your WasteGrid account. {Platform.OS === "web" ? "Your session lasts until this page closes or reloads." : "Your session is securely saved on this device until you sign out."}</AppText>
    </Screen>
  );
}

const s = StyleSheet.create({
  header: { flexDirection: "row", paddingHorizontal: Layout.screenPadding, paddingTop: Spacing.md },
  brand: { width: 230, height: 82, alignSelf: "center", marginBottom: Spacing.md },
  submit: { marginTop: Spacing.sm },
  crewPicker: { gap: Spacing.sm },
  crewLabel: { paddingHorizontal: Spacing.xs },
  crews: { flexDirection: "row", flexWrap: "wrap", gap: Spacing.sm },
});
