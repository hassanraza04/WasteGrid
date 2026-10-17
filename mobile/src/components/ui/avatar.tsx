import { View, StyleSheet } from "react-native";

import { AppText } from "@/components/ui/text";
import { Colors, Radius } from "@/theme";

type Props = { name: string; size?: number };

// Green circle with the first letter of a name or email
export function Avatar({ name, size = 52 }: Props) {
  return (
    <View style={[s.circle, { width: size, height: size }]}>
      <AppText variant={size >= 48 ? "title" : "label"} tone="inverse">{name.charAt(0).toUpperCase()}</AppText>
    </View>
  );
}

const s = StyleSheet.create({
  circle: { borderRadius: Radius.pill, backgroundColor: Colors.primary, alignItems: "center", justifyContent: "center" },
});
