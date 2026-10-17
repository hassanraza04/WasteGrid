import { View, Text, Pressable, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

type Props = {
  onCapture: (uri: string) => void;
  onClose: () => void;
};

// Full-screen camera with a close button and shutter.
export function CameraStep({ onCapture, onClose }: Props) {
  // TODO: useCameraPermissions() — show "Allow camera" / "Open Settings" when not granted
  // TODO: <CameraView ref onCameraReady> filling the screen
  // TODO: shutter → cameraRef.current.takePictureAsync({ quality: 0.7 }) → onCapture(photo.uri)

  return (
    <View style={s.container}>
      <Text style={s.placeholder}>Camera preview</Text>

      <SafeAreaView edges={["top", "bottom"]} pointerEvents="box-none" style={s.overlay}>
        <Pressable style={s.close} onPress={onClose} hitSlop={8}>
          <Feather name="x" size={26} color="#fff" />
        </Pressable>
        <Pressable style={s.shutter} disabled>
          <View style={s.shutterInner} />
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  placeholder: { color: "#888" },
  overlay: { ...StyleSheet.absoluteFill, justifyContent: "space-between" },
  close: { alignSelf: "flex-start", margin: 16 },
  shutter: { alignSelf: "center", marginBottom: 32, width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: "#fff",
             alignItems: "center", justifyContent: "center" },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: "#fff" },
});
