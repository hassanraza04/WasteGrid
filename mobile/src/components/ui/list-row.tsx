import type { ReactNode } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppText } from "@/components/ui/text";
import { Colors, Spacing } from "@/theme";

type Props = {
  title: string;
  subtitle?: string;
  leading?: ReactNode; // icon, avatar or thumbnail
  trailing?: ReactNode; // date, badge, chevron, switch…
  footer?: ReactNode; // extra line under the subtitle
  titleLines?: number;
  divider?: boolean; // hairline under the row, for rows stacked inside one card
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
};

// Title over a muted subtitle, with optional things on either side
export function ListRow({ title, subtitle, leading, trailing, footer, titleLines = 1, divider, onPress, style }: Props) {
  const content = (
    <>
      {leading}
      <View style={s.text}>
        <AppText variant="bodyStrong" numberOfLines={titleLines}>{title}</AppText>
        {subtitle && <AppText variant="caption" tone="muted" numberOfLines={1}>{subtitle}</AppText>}
        {footer}
      </View>
      {trailing}
    </>
  );
  const rowStyle = [s.row, divider && s.divider, style];

  return onPress
    ? <PressableScale style={rowStyle} onPress={onPress} accessibilityRole="button">{content}</PressableScale>
    : <View style={rowStyle}>{content}</View>;
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: Spacing.md, paddingVertical: Spacing.md },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.hairline },
  text: { flex: 1, gap: Spacing.xxs },
});
