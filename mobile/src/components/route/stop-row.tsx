import { View, Linking, StyleSheet } from "react-native";

import { IconButton, ListRow } from "@/components/ui";
import { StopMarker } from "@/components/route/stop-marker";
import { Spacing } from "@/theme";
import type { AssignedStop } from "@/data/assignments";

type Props = {
  stop: AssignedStop;
  index: number;
  divider?: boolean;
  saving?: boolean;
  onToggleCleaned: () => void;
};

// One stop on a crew's route: directions, and mark cleaned / undo
export function StopRow({ stop, index, divider, saving, onToggleCleaned }: Props) {
  const cleaned = !!stop.cleanedAt;
  const navigate = () => {
    const { latitude, longitude } = stop.coords;
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${latitude},${longitude}&travelmode=driving`);
  };

  return (
    <ListRow
      divider={divider}
      leading={<StopMarker index={index} cleaned={cleaned} />}
      title={stop.address}
      subtitle={cleaned ? "Cleaned" : `Report ${stop.reportId}`}
      trailing={
        <View style={s.actions}>
          {!cleaned && <IconButton icon="navigation" variant="sunken" size="sm" accessibilityLabel="Directions" onPress={navigate} />}
          <IconButton
            icon={cleaned ? "rotate-ccw" : "check"}
            variant={cleaned ? "sunken" : "primary"}
            size="sm"
            accessibilityLabel={cleaned ? "Mark not cleaned" : "Mark cleaned"}
            loading={saving}
            onPress={onToggleCleaned}
          />
        </View>
      }
    />
  );
}

const s = StyleSheet.create({
  actions: { flexDirection: "row", gap: Spacing.sm },
});
