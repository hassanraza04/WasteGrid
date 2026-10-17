import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, KeyboardAvoidingView, ActivityIndicator, Platform } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import type { PhotoLocation } from "@/utils/location";

const CAPTION_MAX = 280;

type Props = {
  photoUri: string;
  location: PhotoLocation | null;
  locating: boolean;
  onAddressChange: (address: string) => void;
  onRelocate: () => void;
  caption: string;
  onCaptionChange: (caption: string) => void;
  canSubmit: boolean;
  busy: boolean;
  frozen: boolean;
  fire: boolean | null;
  sharp: boolean | null;
  onFireChange: (value: boolean) => void;
  onSharpChange: (value: boolean) => void;
  onRetake: () => void;
  onSubmit: () => void;
  onClose: () => void;
};

// Photo preview + location + caption, shown after the photo is taken.
export function ReportForm(props: Props) {
  const { photoUri, location, locating, caption, canSubmit } = props;

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <SafeAreaView edges={["top", "bottom"]} style={s.flex}>
        <View style={s.header}>
          <Pressable onPress={props.onClose} disabled={props.busy} hitSlop={8}><Feather name="x" size={24} color="#1E2B26" /></Pressable>
          <Text style={s.title}>New report</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View>
            <Image source={{ uri: photoUri }} style={s.preview} contentFit="cover" />
            <Pressable style={s.retake} disabled={props.frozen} onPress={props.onRetake}>
              <Feather name="refresh-ccw" size={16} color="#fff" />
              <Text style={s.retakeText}>Retake</Text>
            </Pressable>
          </View>

          <Text style={s.label}>Location</Text>
          <View style={s.row}>
            <TextInput
              style={[s.input, s.flex]}
              value={location?.address ?? ""}
              editable={!props.frozen}
              onChangeText={props.onAddressChange}
              placeholder={locating ? "Finding your location…" : "Street, area or landmark"}
              placeholderTextColor="#8A9690"
            />
            <Pressable style={s.locate} onPress={props.onRelocate} disabled={locating || props.frozen} hitSlop={4}>
              {locating ? <ActivityIndicator color="#2F6B55" /> : <Feather name="crosshair" size={20} color="#2F6B55" />}
            </Pressable>
          </View>
          {location?.coords && (
            <Text style={s.hint}>{location.coords.latitude.toFixed(5)}, {location.coords.longitude.toFixed(5)}</Text>
          )}

          <Text style={s.label}>Caption</Text>
          <TextInput
            style={[s.input, s.caption]}
            value={caption}
            editable={!props.frozen}
            onChangeText={props.onCaptionChange}
            placeholder="What's the problem? e.g. overflowing bin, dumped bags"
            placeholderTextColor="#8A9690"
            multiline
            maxLength={CAPTION_MAX}
            textAlignVertical="top"
          />
          <Text style={s.hint}>{caption.length}/{CAPTION_MAX}</Text>
          {!location?.coords && <Text accessibilityRole="alert">Enable location to submit this report.</Text>}
          <Text style={s.label}>Is there fire or smoke?</Text>
          <View style={s.row}>{[true, false].map(value => <Pressable key={String(value)} disabled={props.frozen} accessibilityRole="radio" accessibilityState={{ checked: props.fire === value }} onPress={() => props.onFireChange(value)} style={s.input}><Text>{props.fire === value ? "● " : "○ "}{value ? "Yes" : "No"}</Text></Pressable>)}</View>
          <Text style={s.label}>Are there sharp objects?</Text>
          <View style={s.row}>{[true, false].map(value => <Pressable key={String(value)} disabled={props.frozen} accessibilityRole="radio" accessibilityState={{ checked: props.sharp === value }} onPress={() => props.onSharpChange(value)} style={s.input}><Text>{props.sharp === value ? "● " : "○ "}{value ? "Yes" : "No"}</Text></Pressable>)}</View>
          {props.frozen && !props.busy && <Text>The original upload is saved. Retry it here or from My reports.</Text>}
        </ScrollView>

        <Pressable style={[s.submit, !canSubmit && s.disabled]} onPress={props.onSubmit} disabled={!canSubmit}>
          <Text style={s.submitText}>{props.busy ? "Submitting…" : props.frozen ? "Retry saved upload" : "Submit report"}</Text>
        </Pressable>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: "#F6F8F7" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 18, fontWeight: "600", color: "#1E2B26" },
  body: { padding: 16, gap: 8 },
  preview: { width: "100%", aspectRatio: 3 / 4, borderRadius: 16, backgroundColor: "#DDE3E0" },
  retake: { position: "absolute", right: 12, bottom: 12, flexDirection: "row", alignItems: "center", gap: 6,
            backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  retakeText: { color: "#fff", fontWeight: "600" },
  label: { marginTop: 12, fontSize: 14, fontWeight: "600", color: "#1E2B26" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#DDE3E0",
           paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: "#1E2B26" },
  locate: { width: 48, height: 48, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#DDE3E0",
            alignItems: "center", justifyContent: "center" },
  caption: { minHeight: 110 },
  hint: { fontSize: 12, color: "#8A9690" },
  submit: { marginHorizontal: 24, marginBottom: 12, height: 56, borderRadius: 16, backgroundColor: "#18a545",
            alignItems: "center", justifyContent: "center" },
  submitText: { color: "#fff", fontSize: 17, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});
