import { useRef, useState, useEffect } from "react";
import { View, StyleSheet, Linking } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { playSfx, preloadSounds } from '@/utils/sounds';
import { AppText, Button, IconButton, PressableScale } from '@/components/ui';
import { Colors, Layout, Spacing } from '@/theme';

type Props = {
  onCapture: (uri: string) => void;
  onClose: () => void;
};

// Full-screen camera with a close button and shutter.
export function CameraStep({ onCapture, onClose }: Props) {
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [ready, setReady] = useState(false); // takePictureAsync fails before onCameraReady
  const [busy, setBusy] = useState(false);   // blocks double-taps on the shutter
  useEffect(() => { preloadSounds(); }, []);

  if (!permission) return <View style={s.container}><StatusBar style="light" /></View>; // permission status still loading

  if (!permission.granted) {
    return (
      <SafeAreaView style={[s.container, s.center]}>
        <StatusBar style="light" />
        <AppText variant="title" tone="inverse" align="center">WasteGrid needs your camera to photograph waste reports.</AppText>
        <Button
          label={permission.canAskAgain ? "Allow camera" : "Open Settings"}
          icon="camera"
          onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}
          style={s.permissionBtn}
        />
        <PressableScale onPress={onClose} hitSlop={12}><AppText variant="label" tone="inverseMuted">Cancel</AppText></PressableScale>
      </SafeAreaView>
    );
  }

  const takePhoto = async () => {
    if (!ready || busy) return;
    setBusy(true);
    playSfx("camera_shutter");
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7, shutterSound: false});
      if (photo) onCapture(photo.uri);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.container}>
      <StatusBar style="light" />
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setReady(true)} />

      <SafeAreaView edges={["top", "bottom"]} pointerEvents="box-none" style={s.overlay}>
        <IconButton icon="x" variant="scrim" accessibilityLabel="Close camera" onPress={onClose} style={s.close} />
        <PressableScale haptic="heavy" style={[s.shutter, (!ready || busy) && s.disabled]} onPress={takePhoto} disabled={!ready || busy}
                        accessibilityRole="button" accessibilityLabel="Take photo">
          <View style={s.shutterInner} />
        </PressableScale>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.cameraBackground },
  center: { alignItems: "center", justifyContent: "center", padding: Spacing.xxxl, gap: Spacing.lg },
  permissionBtn: { alignSelf: "stretch", marginTop: Spacing.sm },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: "space-between" },
  close: { alignSelf: "flex-start", margin: Layout.screenPadding },
  shutter: { alignSelf: "center", marginBottom: Spacing.xxxl, width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: Colors.onDark,
             alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: Colors.onDark },
  disabled: { opacity: 0.5 },
});
