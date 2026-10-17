// app/(tabs)/index.tsx — Explore screen
import { useRef } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import MapView, { PROVIDER_GOOGLE, Polygon, Marker } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Location from "expo-location";
import mapStyle from "../../theme/mapStyle.json";
import { router } from "expo-router";

const DEFAULT_POS = { latitude: 24.8138, longitude: 67.03, latitudeDelta: 0.03, longitudeDelta: 0.03 };

// Returns null if permission is denied or location is unavailable (e.g. services off)
async function getUserRegion() {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") return null;
  try {
    const { coords } = await Location.getCurrentPositionAsync({});
    return { latitude: coords.latitude, longitude: coords.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 };
  } catch {
    return null;
  }
}

export default function MapPage() {
  const mapRef = useRef<MapView>(null);

  const recenter = async () => {
    const region = await getUserRegion();
    if (!region) return; // show "enable location" hint here
    mapRef.current?.animateToRegion(region, 400);
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Layer 1: the map fills the screen */}
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialRegion={DEFAULT_POS}
        onMapReady={recenter}
        customMapStyle={mapStyle}
        showsUserLocation
        showsMyLocationButton={false}   // you have your own button
        toolbarEnabled={false}
        mapPadding={{ top: 90, bottom: 110, left: 0, right: 0 }} // keeps Google logo clear of overlays
      >

        {/* reports.map(r => <Marker key={r.id} coordinate={...} />) */}
      </MapView>

      {/* Layer 2: overlays. box-none lets touches pass through to the map */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={s.header}>
        <View style={s.brand}><Text style={s.title}>WasteGrid</Text></View>
        <Pressable style={s.avatar}><Text style={s.avatarText}>P</Text></Pressable>
      </SafeAreaView>

      <View pointerEvents="box-none" style={s.fabs}>
        <Pressable style={s.fab}><Feather name="layers" size={22} color="#1E2B26" /></Pressable>
        <Pressable style={s.fab} onPress={recenter}><Feather name="crosshair" size={22} color="#1E2B26" /></Pressable>
      </View>

      <Pressable style={s.cta} onPress={() => {router.push("/report")}}>
        <Feather name="camera" size={20} color="#fff" /><Text style={s.ctaText}>Report waste</Text>
      </Pressable>
    </View>
  );
}

const shadow = { elevation: 4, shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } };
const s = StyleSheet.create({
  header: { position: "absolute", top: 0, left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  brand: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 22, fontWeight: "500", color: "#1E2B26" },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", ...shadow },
  avatarText: { fontWeight: "700", fontSize: 13 },
  fabs: { position: "absolute", right: 16, bottom: 104, gap: 12 },
  fab: { width: 52, height: 52, borderRadius: 14, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", ...shadow },
  cta: { position: "absolute", left: 24, right: 24, bottom: 20, height: 64, borderRadius: 16, backgroundColor: "#17af4f",
         flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, ...shadow },
  ctaText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});