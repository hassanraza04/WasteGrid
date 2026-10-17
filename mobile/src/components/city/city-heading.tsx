import { View, StyleSheet } from "react-native";

import { AppText, Button, Icon } from "@/components/ui";
import { Colors, Spacing } from "@/theme";
import type { City } from "@/data/cities";

type Props = {
  city: City;
  isLocal: boolean;
  onBackToLocal?: () => void; // shows a "My area" button when set
};

// City name with "Your area" (or its region), plus a way back to the user's own city
export function CityHeading({ city, isLocal, onBackToLocal }: Props) {
  return (
    <View style={s.row}>
      <View style={s.text}>
        <AppText variant="headline">{city.name}</AppText>
        {isLocal ? (
          <View style={s.localTag}>
            <Icon name="navigation" size={13} color={Colors.primary} />
            <AppText variant="caption" tone="primary">Your area</AppText>
          </View>
        ) : (
          <AppText variant="caption" tone="muted">{city.region}</AppText>
        )}
      </View>
      {onBackToLocal && <Button label="My area" icon="navigation" variant="ghost" onPress={onBackToLocal} />}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: Spacing.md, marginTop: Spacing.sm },
  text: { flex: 1 },
  localTag: { flexDirection: "row", alignItems: "center", gap: Spacing.xs },
});
