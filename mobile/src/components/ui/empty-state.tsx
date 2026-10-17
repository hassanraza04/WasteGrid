import type { ReactNode } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { AppText } from "@/components/ui/text";
import { Icon, type IconName } from "@/components/ui/icon";
import { Colors, Radius, Spacing } from "@/theme";

type Props = {
  icon: IconName;
  title: string;
  message?: string;
  action?: ReactNode; // usually a <Button>
  style?: StyleProp<ViewStyle>;
};

// Centered icon + message for "nothing here yet" and "log in to see this"
export function EmptyState({ icon, title, message, action, style }: Props) {
  return (
    <View style={[s.container, style]}>
      <View style={s.iconWrap}><Icon name={icon} size={28} color={Colors.inkMuted} /></View>
      <AppText variant="title" align="center">{title}</AppText>
      {message && <AppText tone="muted" align="center">{message}</AppText>}
      {action && <View style={s.action}>{action}</View>}
    </View>
  );
}

const s = StyleSheet.create({
  container: { alignItems: "center", gap: Spacing.sm, paddingHorizontal: Spacing.xxl },
  iconWrap: { width: 64, height: 64, borderRadius: Radius.pill, backgroundColor: Colors.surfaceSunken,
              alignItems: "center", justifyContent: "center", marginBottom: Spacing.sm },
  action: { marginTop: Spacing.lg, alignSelf: "stretch" },
});
