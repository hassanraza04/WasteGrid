import { View, StyleSheet } from "react-native";

import { AppText, Icon } from "@/components/ui";
import { Colors, Radius } from "@/theme";

type Props = { index: number; cleaned: boolean };

// Numbered circle for a route stop (a check once cleaned). Used on the map and in the stop list.
export function StopMarker({ index, cleaned }: Props) {
  return (
    <View style={[s.circle, cleaned && s.cleaned]}>
      {cleaned
        ? <Icon name="check" size={14} color={Colors.onPrimary} />
        : <AppText variant="micro" tone="inverse">{index + 1}</AppText>}
    </View>
  );
}

const s = StyleSheet.create({
  circle: { width: 28, height: 28, borderRadius: Radius.pill, backgroundColor: Colors.ink, borderWidth: 2, borderColor: Colors.surface,
            alignItems: "center", justifyContent: "center" },
  cleaned: { backgroundColor: Colors.primary },
});
