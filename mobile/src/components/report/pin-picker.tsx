import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { AppText, Button, Screen } from "@/components/ui";
import { Sizes } from "@/theme";
import type { Coords } from "@/utils/location";
import { DEFAULT_REGION } from "@/utils/map";
import { PinMap } from "./pin-map";

export function PinPicker({ initial, onConfirm, onClose }: { initial: Coords | null; onConfirm: (coords: Coords) => void; onClose: () => void }) {
  const [center] = useState<Coords>(() => initial ?? { latitude: DEFAULT_REGION.latitude, longitude: DEFAULT_REGION.longitude });
  const [pin, setPin] = useState<Coords | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setFailed(true), 15_000);
    return () => clearTimeout(timer);
  }, [ready]);
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <Screen tabBar={false} edges={["top", "bottom"]}>
      <AppText variant="title">Choose report location</AppText>
      <AppText>Tap the exact waste location, then confirm the pin. Moving the map alone does not select a location.</AppText>
      <View style={s.map}><PinMap center={center} onPin={setPin} onReady={() => { setReady(true); setFailed(false); }} onError={() => setFailed(true)} /></View>
      {failed && <AppText accessibilityRole="alert">The map could not load. Check your connection and reopen it, or use GPS.</AppText>}
      {pin && <AppText>{pin.latitude.toFixed(5)}, {pin.longitude.toFixed(5)}</AppText>}
      <Button label="Confirm this pin" disabled={!pin || !ready || failed} onPress={() => { if (pin) onConfirm(pin); }} />
      <Button label="Cancel location selection" variant="outline" onPress={onClose} />
    </Screen>
  </Modal>;
}
const s = StyleSheet.create({ map: { height: Sizes.mapPicker } });
