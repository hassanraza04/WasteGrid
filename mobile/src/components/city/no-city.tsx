import { StyleSheet } from "react-native";

import { EmptyState } from "@/components/ui";
import { Spacing } from "@/theme";
import type { LocalCity } from "@/hooks/use-local-city";

// What to show before there's a city: still locating, location off, or no data where the user is
export function NoCity({ local }: { local: LocalCity }) {
  if (local.status === "locating") {
    return <EmptyState icon="navigation" title="Finding your city…" message="Or search for any city above." style={s.container} />;
  }
  if (local.status === "unsupported") {
    return (
      <EmptyState
        icon="map-pin"
        title={`No data for ${local.placeName ?? "your area"} yet`}
        message="Search for another city to see how it's doing."
        style={s.container}
      />
    );
  }
  return (
    <EmptyState
      icon="map-pin"
      title="Search for a city"
      message="Turn on location to open your own city automatically."
      style={s.container}
    />
  );
}

const s = StyleSheet.create({
  container: { marginTop: Spacing.xxxl },
});
