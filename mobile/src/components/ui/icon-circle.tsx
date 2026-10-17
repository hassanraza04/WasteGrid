import { View, StyleSheet } from "react-native";

import { Icon, type IconName } from "@/components/ui/icon";
import { Colors, Radius, Sizes } from "@/theme";

type Props = {
  icon: IconName;
  faint?: boolean; // greyed-out icon, e.g. for something inactive
};

// Small grey circle with an icon, used as the leading item in list rows
export function IconCircle({ icon, faint }: Props) {
  return (
    <View style={s.circle}>
      <Icon name={icon} size={Sizes.iconSm} color={faint ? Colors.inkFaint : Colors.ink} />
    </View>
  );
}

const s = StyleSheet.create({
  circle: { width: 36, height: 36, borderRadius: Radius.pill, backgroundColor: Colors.surfaceSunken, alignItems: "center", justifyContent: "center" },
});
