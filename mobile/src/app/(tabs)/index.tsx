// app/(tabs)/index.tsx — Explore screen
import { useCallback, useRef, useState } from "react";
import { View, StyleSheet, ActivityIndicator, AppState } from "react-native";
import MapView, { Marker, PROVIDER_GOOGLE, type Region } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import mapStyle from "@/theme/mapStyle.json";

import { AppText, Button, Card, IconButton, useTabBarClearance } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { WasteMarker } from "@/components/map/waste-marker";
import { useStartRegion } from "@/hooks/use-start-region";
import { readMapMarkers, type MapMarkerLocation } from "@/services/map-markers";
import { getCurrentCoords } from "@/utils/location";
import { regionAround } from "@/utils/map";
import { Colors, Layout, Spacing } from "@/theme";

export default function MapPage() {
  const mapRef = useRef<MapView>(null);
  const start = useStartRegion();
  const clearance = useTabBarClearance();
  const [locating, setLocating] = useState(false); // GPS can take seconds — show a spinner meanwhile
  const [cardHeight, setCardHeight] = useState(0);
  const [viewport, setViewport] = useState<Region | null>(null);
  const [markers, setMarkers] = useState<MapMarkerLocation[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [mapError, setMapError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const region = viewport ?? start?.region;

  useFocusEffect(useCallback(() => {
    if (!region) return;
    let active = true;
    let revision = 0;
    const load = async () => {
      if (AppState.currentState === "background") return;
      const current = ++revision;
      setRefreshing(true);
      try {
        const page = await readMapMarkers(region);
        if (!active || current !== revision) return;
        setMarkers(page.items);
        setTruncated(page.truncated);
        setMapError("");
      } catch {
        if (!active || current !== revision) return;
        setMarkers([]);
        setTruncated(false);
        setMapError("Waste locations could not be updated. Tap refresh to retry.");
      } finally {
        if (active && current === revision) setRefreshing(false);
      }
    };
    refresh.current = () => { void load(); };
    const initial = setTimeout(() => { void load(); }, 250);
    const timer = setInterval(() => { void load(); }, 30_000);
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void load();
      else { revision++; setRefreshing(false); }
    });
    return () => {
      active = false;
      revision++;
      clearTimeout(initial);
      clearInterval(timer);
      subscription.remove();
    };
  }, [region]));

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
          onRegionChangeComplete={setViewport}
          onMapReady={start.locateLater ? recenter : undefined}
          customMapStyle={mapStyle}
          showsUserLocation
          showsMyLocationButton={false}   // you have your own button
          toolbarEnabled={false}
          mapPadding={{ top: 0, bottom: cardBottom + cardHeight, left: 0, right: 0 }} // keeps the Google logo clear of the card
        >

          {markers.map(point => <Marker
            key={`${point.latitude},${point.longitude}`}
            coordinate={point}
            title="Reported waste"
            description="Approximate location; removed after crew completion"
            accessibilityLabel="Reported waste location"
            anchor={{ x: 0.5, y: 0.5 }}
          ><WasteMarker /></Marker>)}
        </MapView>
      ) : (
        <View style={s.placeholder}><ActivityIndicator color={Colors.ink} /></View>
      )}

      {/* Layer 2: overlays. box-none lets touches pass through to the map */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={s.account}>
        <AccountButton floating />
      </SafeAreaView>

      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={s.controls}>
        <IconButton icon="refresh-cw" accessibilityLabel="Refresh waste locations" onPress={() => refresh.current()} loading={refreshing} />
        <IconButton icon="crosshair" accessibilityLabel="Center on my location" onPress={recenter} loading={locating} />
      </SafeAreaView>

      <Card style={[s.card, { bottom: cardBottom }]} onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}>
        <AppText variant="headline" align="center">Spotted waste?</AppText>
        <AppText tone="muted" align="center" style={s.cardText}>Snap a photo and we&apos;ll get it cleaned up.</AppText>
        <AppText variant="micro" tone={mapError ? "warning" : "muted"} align="center">
          {mapError || (truncated ? "Zoom in to see more waste locations." : "Bin markers show approximate locations and disappear after cleanup.")}
        </AppText>
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
