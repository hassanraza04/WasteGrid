import { View, StyleSheet } from "react-native";

import { AppText } from "@/components/ui";
import type { AssignedStop } from "@/data/assignments";
import { Colors, Radius, Spacing } from "@/theme";

// Preserve the route summary on Web without loading react-native-maps.
export function RouteMap({ stops }: { stops: AssignedStop[] }) {
  return <View style={s.frame}>
    <AppText variant="headline">Route stops</AppText>
    {stops.map((stop, index) => <AppText key={stop.reportId}>
      {index + 1}. {stop.address}
    </AppText>)}
  </View>;
}

const s = StyleSheet.create({
  frame: { gap: Spacing.sm, padding: Spacing.md, borderRadius: Radius.lg, backgroundColor: Colors.surfaceSunken },
});
