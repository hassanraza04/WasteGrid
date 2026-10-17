import { View, Text, Pressable, StyleSheet, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import type { PhotoLocation } from "@/utils/location";

type Props = {
  photoUri: string;
  location: PhotoLocation | null;
  onLocationChange: (location: PhotoLocation) => void;
  onRelocate: () => void;
  caption: string;
  onCaptionChange: (caption: string) => void;
  onRetake: () => void;
  onSubmit: () => void;
  onClose: () => void;
};

// Photo preview + location + caption, shown after the photo is taken.
export function ReportForm({ onRetake, onSubmit, onClose }: Props) {
  // TODO: wrap in KeyboardAvoidingView so inputs stay visible
  // TODO: disable submit until there's a caption and a location

  return (
    <SafeAreaView edges={["top", "bottom"]} style={s.container}>
      <View style={s.header}>
        <Pressable onPress={onClose} hitSlop={8}><Feather name="x" size={24} color="#1E2B26" /></Pressable>
        <Text style={s.title}>New report</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        {/* TODO: <Image source={{ uri: photoUri }} /> from expo-image + Retake button */}
        <Pressable onPress={onRetake}><Text>Retake</Text></Pressable>

        <Text style={s.label}>Location</Text>
        {/* TODO: TextInput bound to location.address + crosshair button → onRelocate; show coords underneath */}

        <Text style={s.label}>Caption</Text>
        {/* TODO: multiline TextInput bound to caption */}
      </ScrollView>

      <Pressable style={s.submit} onPress={onSubmit}>
        <Text style={s.submitText}>Submit report</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#F6F8F7" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 18, fontWeight: "600", color: "#1E2B26" },
  body: { padding: 16, gap: 8 },
  label: { marginTop: 12, fontSize: 14, fontWeight: "600", color: "#1E2B26" },
  submit: { marginHorizontal: 24, marginBottom: 12, height: 56, borderRadius: 16, backgroundColor: "#3A7A64", alignItems: "center", justifyContent: "center" },
  submitText: { color: "#fff", fontSize: 17, fontWeight: "600" },
});
