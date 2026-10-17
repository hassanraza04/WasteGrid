// app/login.tsx — Log in (frontend only: any email/password is accepted)
import { useRef, useState } from "react";
import { View, Text, TextInput, StyleSheet, KeyboardAvoidingView, Platform, type TextInputInstance } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";

import { PressableScale } from "@/components/ui/pressable-scale";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { signIn, type Role } from "@/auth/session";
import { AppColors } from "@/constants/theme";

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
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SafeAreaView edges={["top", "bottom"]} style={s.flex}>
        <View style={s.header}>
          <PressableScale onPress={() => router.back()} hitSlop={12}><Feather name="x" size={24} color={AppColors.text} /></PressableScale>
        </View>

        <View style={s.body}>
          <Text style={s.title}>Log in</Text>
          <Text style={s.subtitle}>Track cleanups in your city. Admins can plan crew routes.</Text>

          <SegmentedControl options={ROLES} value={role} onChange={switchRole} style={s.segmented} />

          <Text style={s.label}>Email</Text>
          <TextInput
            style={s.input}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={AppColors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            keyboardType="email-address"
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />

          <Text style={s.label}>Password</Text>
          <TextInput
            ref={passwordRef}
            style={s.input}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={AppColors.textMuted}
            secureTextEntry
            autoComplete="password"
            returnKeyType="go"
            onSubmitEditing={logIn}
          />

          <PressableScale haptic="medium" style={[s.submit, !canLogIn && s.disabled]} onPress={logIn} disabled={!canLogIn}>
            <Text style={s.submitText}>Log in</Text>
          </PressableScale>
          <Text style={s.hint}>Demo: any email and password will work.</Text>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: AppColors.background },
  header: { flexDirection: "row", paddingHorizontal: 16, paddingVertical: 12 },
  body: { paddingHorizontal: 24, paddingTop: 8, gap: 8 },
  title: { fontSize: 28, fontWeight: "700", color: AppColors.text },
  subtitle: { fontSize: 15, color: AppColors.textMuted, marginBottom: 16 },
  segmented: { marginBottom: 8 },
  label: { marginTop: 8, fontSize: 14, fontWeight: "600", color: AppColors.text },
  input: { backgroundColor: AppColors.surface, borderRadius: 12, borderWidth: 1, borderColor: AppColors.border,
           paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: AppColors.text },
  submit: { marginTop: 20, height: 56, borderRadius: 16, backgroundColor: AppColors.primary, alignItems: "center", justifyContent: "center" },
  submitText: { color: AppColors.onPrimary, fontSize: 17, fontWeight: "600" },
  hint: { fontSize: 12, color: AppColors.textMuted, textAlign: "center", marginTop: 4 },
  disabled: { opacity: 0.5 },
});
