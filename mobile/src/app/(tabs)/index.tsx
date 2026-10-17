// app/(tabs)/index.tsx — Explore screen
import { useRef, useState } from "react";
import { View, StyleSheet, ActivityIndicator } from "react-native";
import MapView, { PROVIDER_GOOGLE } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import mapStyle from "@/theme/mapStyle.json";

import { AppText, Button, Card, IconButton, useTabBarClearance } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { useStartRegion } from "@/hooks/use-start-region";
import { getCurrentCoords } from "@/utils/location";
import { regionAround } from "@/utils/map";
import { Colors, Layout, Spacing } from "@/theme";

export default function MapPage() {
  const mapRef = useRef<MapView>(null);
  const start = useStartRegion();
  const clearance = useTabBarClearance();
  const [locating, setLocating] = useState(false); // GPS can take seconds — show a spinner meanwhile
  const [cardHeight, setCardHeight] = useState(0);

  const cardBottom = clearance - Spacing.sm; // just above the floating tab bar

  const recenter = async () => {
    setLocating(true);
    try {
      const result = await getCurrentCoords();
      if (!result.ok) return; // show "enable location" hint here (result.reason says why)
      mapRef.current?.animateToRegion(regionAround(result.coords), 400);
    } finally {
      setLocating(false);
    }
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Layer 1: the map fills the screen — a plain placeholder until we know where to open it */}
      {start ? (
        <MapView
          ref={mapRef}
          provider={PROVIDER_GOOGLE}
          style={StyleSheet.absoluteFill}
          initialRegion={start.region}
          onMapReady={start.locateLater ? recenter : undefined}
          customMapStyle={mapStyle}
          showsUserLocation
          showsMyLocationButton={false}   // you have your own button
          toolbarEnabled={false}
          mapPadding={{ top: 0, bottom: cardBottom + cardHeight, left: 0, right: 0 }} // keeps the Google logo clear of the card
        >

          {/* reports.map(r => <Marker key={r.id} coordinate={...} />) */}
        </MapView>
      ) : (
        <View style={s.placeholder}><ActivityIndicator color={Colors.ink} /></View>
      )}

      {/* Layer 2: overlays. box-none lets touches pass through to the map */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={s.account}>
        <AccountButton floating />
      </SafeAreaView>

      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={s.controls}>
        <IconButton icon="layers" accessibilityLabel="Map layers" onPress={() => {}} /* TODO: layer picker */ />
        <IconButton icon="crosshair" accessibilityLabel="Center on my location" onPress={recenter} loading={locating} />
      </SafeAreaView>

      <Card style={[s.card, { bottom: cardBottom }]} onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}>
        <AppText variant="headline" align="center">Spotted waste?</AppText>
        <AppText tone="muted" align="center" style={s.cardText}>Snap a photo and we&apos;ll get it cleaned up.</AppText>
        <Button label="Report waste" icon="camera" onPress={() => router.push("/report")} />
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  placeholder: { ...StyleSheet.absoluteFill, backgroundColor: Colors.background, alignItems: "center", justifyContent: "center" },
  account: { position: "absolute", top: Spacing.sm, left: Layout.screenPadding },
  controls: { position: "absolute", top: Spacing.sm, right: Layout.screenPadding, gap: Spacing.md },
  card: { position: "absolute", left: Layout.screenPadding, right: Layout.screenPadding, gap: Spacing.xs },
  cardText: { marginBottom: Spacing.md },
});
