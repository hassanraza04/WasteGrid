import type { ReactNode } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { AppText } from "@/components/ui/text";
import { Spacing } from "@/theme";

type Props = {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

// Large headline at the top of a screen
export function ScreenHeader({ title, subtitle, trailing, style }: Props) {
  return (
    <View style={[s.row, style]}>
      <View style={s.text}>
        <AppText variant="display" accessibilityRole="header">{title}</AppText>
        {subtitle && <AppText tone="muted">{subtitle}</AppText>}
      </View>
      {trailing}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.md },
  text: { flex: 1, gap: Spacing.xs },
});
