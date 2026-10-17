import { useRef, useState, useEffect } from "react";
import { View, Text, StyleSheet, Linking } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { playSfx, preloadSounds } from '@/utils/sounds';
import { AppColors } from '@/constants/theme';
import { PressableScale } from '@/components/ui/pressable-scale';

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
  
  if (!permission) return <View style={s.container} />; // permission status still loading

  if (!permission.granted) {
    return (
      <SafeAreaView style={[s.container, s.center]}>
        <Text style={s.message}>WasteGrid needs your camera to photograph waste reports.</Text>
        <PressableScale
          haptic="medium"
          style={s.permissionBtn}
          onPress={() => (permission.canAskAgain ? requestPermission() : Linking.openSettings())}>
          <Text style={s.permissionText}>{permission.canAskAgain ? "Allow camera" : "Open Settings"}</Text>
        </PressableScale>
        <PressableScale onPress={onClose} hitSlop={12}><Text style={s.cancel}>Cancel</Text></PressableScale>
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
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" onCameraReady={() => setReady(true)} />

      <SafeAreaView edges={["top", "bottom"]} pointerEvents="box-none" style={s.overlay}>
        <PressableScale style={s.close} onPress={onClose} hitSlop={12}>
          <Feather name="x" size={26} color={AppColors.onDark} />
        </PressableScale>
        <PressableScale haptic="heavy" style={[s.shutter, (!ready || busy) && s.disabled]} onPress={takePhoto} disabled={!ready || busy}>
          <View style={s.shutterInner} />
        </PressableScale>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: AppColors.cameraBackground },
  center: { alignItems: "center", justifyContent: "center", padding: 32, gap: 16 },
  message: { color: AppColors.onDark, fontSize: 16, textAlign: "center" },
  permissionBtn: { backgroundColor: AppColors.primary, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 14 },
  permissionText: { color: AppColors.onPrimary, fontSize: 16, fontWeight: "600" },
  cancel: { color: AppColors.onDarkMuted, fontSize: 15 },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: "space-between" },
  close: { alignSelf: "flex-start", margin: 16 },
  shutter: { alignSelf: "center", marginBottom: 32, width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: AppColors.onDark,
             alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: AppColors.onDark },
  disabled: { opacity: 0.5 },
});