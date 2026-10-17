import { View, StyleSheet, type ViewProps } from "react-native";

import { Colors, Radius, Shadow, Spacing } from "@/theme";

type Props = ViewProps & {
  padding?: number;
};

// White rounded surface that sits on the grey background
export function Card({ padding = Spacing.xl, style, ...rest }: Props) {
  return <View {...rest} style={[s.card, { padding }, style]} />;
}

const s = StyleSheet.create({
  card: { backgroundColor: Colors.surface, borderRadius: Radius.lg, ...Shadow.card },
});
