import { StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui";
import { Colors, Radius } from "@/theme";

// Feather is already bundled through the app's Icon component.
export function WasteMarker() {
  return <View style={styles.marker}><Icon name="trash-2" size={17} color={Colors.onPrimary} /></View>;
}

const styles = StyleSheet.create({
  marker: {
    width: 36, height: 36, borderRadius: Radius.pill,
    alignItems: "center", justifyContent: "center",
    backgroundColor: Colors.ink, borderColor: Colors.surface, borderWidth: 3,
  },
});
