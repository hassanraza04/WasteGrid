import { View, StyleSheet } from "react-native";

import { AppText, Icon, ListRow } from "@/components/ui";
import { Colors, Radius, Sizes } from "@/theme";
import type { Cleanup } from "@/data/stats";

// One line in "Recently cleaned". Stack several inside a Card; `divider` separates them.
export function CleanupRow({ cleanup, divider }: { cleanup: Cleanup; divider?: boolean }) {
  const date = new Date(cleanup.cleanedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <ListRow
      divider={divider}
      leading={<View style={s.icon}><Icon name="check" size={Sizes.iconSm} color={Colors.primary} /></View>}
      title={cleanup.caption}
      subtitle={cleanup.address}
      trailing={<AppText variant="caption" tone="muted">{date}</AppText>}
    />
  );
}

const s = StyleSheet.create({
  icon: { width: 36, height: 36, borderRadius: Radius.pill, backgroundColor: Colors.primarySoft, alignItems: "center", justifyContent: "center" },
});
