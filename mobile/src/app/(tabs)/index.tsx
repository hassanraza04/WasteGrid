// app/(tabs)/index.tsx — Explore screen
import { useRef, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Alert } from "react-native";
import MapView, { PROVIDER_GOOGLE } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import mapStyle from "../../theme/mapStyle.json";
import { router } from "expo-router";

import { PressableScale } from "@/components/ui/pressable-scale";
import { signOut, useSession } from "@/auth/session";
import { useStartRegion } from "@/hooks/use-start-region";
import { getCurrentCoords } from "@/utils/location";
import { regionAround } from "@/utils/map";
import { AppColors } from "@/constants/theme";

export default function MapPage() {
  const mapRef = useRef<MapView>(null);
  const start = useStartRegion();
  const session = useSession();
  const [locating, setLocating] = useState(false); // GPS can take seconds — show a spinner meanwhile

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

  // Top-left button: log in when signed out, log out (after confirming) when signed in
  const onAccountPress = () => {
    if (!session) {
      router.push("/login");
      return;
    }
    Alert.alert("Log out?", `You're signed in as ${session.email}.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Log out", style: "destructive", onPress: signOut },
    ]);
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
          mapPadding={{ top: 90, bottom: 110, left: 0, right: 0 }} // keeps Google logo clear of overlays
        >

          {/* reports.map(r => <Marker key={r.id} coordinate={...} />) */}
        </MapView>
      ) : (
        <View style={s.placeholder}><ActivityIndicator color={AppColors.text} /></View>
      )}

      {/* Layer 2: overlays. box-none lets touches pass through to the map */}
      <SafeAreaView edges={["top"]} pointerEvents="box-none" style={s.header}>
        <View style={s.brand}>
          <PressableScale style={[s.avatar, session && s.avatarSignedIn]} onPress={onAccountPress}
                          accessibilityLabel={session ? `Account, signed in as ${session.email}` : "Log in"}>
            {session
              ? <Text style={s.avatarText}>{session.email.charAt(0).toUpperCase()}</Text>
              : <Feather name="log-in" size={18} color={AppColors.text} />}
          </PressableScale>
          <Text style={s.title}>WasteGrid</Text>
        </View>
      </SafeAreaView>

      <View pointerEvents="box-none" style={s.fabs}>
        <PressableScale style={s.fab}><Feather name="layers" size={22} color={AppColors.text} /></PressableScale>
        <PressableScale style={s.fab} onPress={recenter} disabled={locating}>
          {locating ? <ActivityIndicator color={AppColors.text} /> : <Feather name="crosshair" size={22} color={AppColors.text} />}
        </PressableScale>
      </View>

      <PressableScale haptic="medium" style={s.cta} onPress={() => {router.push("/report")}}>
        <Feather name="camera" size={20} color={AppColors.onPrimary} /><Text style={s.ctaText}>Report waste</Text>
      </PressableScale>
    </View>
  );
}

const shadow = { elevation: 4, shadowColor: AppColors.shadow, shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } };
const s = StyleSheet.create({
  placeholder: { ...StyleSheet.absoluteFill, backgroundColor: AppColors.background, alignItems: "center", justifyContent: "center" },
  header: { position: "absolute", top: 0, left: 16, right: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 22, fontWeight: "500", color: AppColors.text },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: AppColors.surface, alignItems: "center", justifyContent: "center", ...shadow },
  avatarSignedIn: { backgroundColor: AppColors.primary },
  avatarText: { fontWeight: "700", fontSize: 17, color: AppColors.onPrimary },
  fabs: { position: "absolute", right: 16, bottom: 104, gap: 12 },
  fab: { width: 52, height: 52, borderRadius: 14, backgroundColor: AppColors.surface, alignItems: "center", justifyContent: "center", ...shadow },
  cta: { position: "absolute", left: 24, right: 24, bottom: 20, height: 64, borderRadius: 16, backgroundColor: AppColors.primary,
         flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, ...shadow },
  ctaText: { color: AppColors.onPrimary, fontSize: 17, fontWeight: "600" },
});