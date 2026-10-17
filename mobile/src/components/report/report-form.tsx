import { View, Text, TextInput, StyleSheet, ScrollView, KeyboardAvoidingView, ActivityIndicator, Platform } from "react-native";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppColors } from "@/constants/theme";
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
          <PressableScale onPress={props.onClose} hitSlop={12}><Feather name="x" size={24} color={AppColors.text} /></PressableScale>
          <Text style={s.title}>New report</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View>
            <Image
              source={{ uri: photoUri }}
              style={s.preview}
              contentFit="cover"
            />
            <PressableScale style={s.retake} onPress={props.onRetake}>
              <Feather name="refresh-ccw" size={16} color={AppColors.onDark} />
              <Text style={s.retakeText}>Retake</Text>
            </PressableScale>
          </View>

          <Text style={s.label}>Location</Text>
          <View style={s.row}>
            <TextInput
              style={[s.input, s.flex]}
              value={location?.address ?? ""}
              onChangeText={props.onAddressChange}
              placeholder={locating ? "Finding your location…" : "Street, area or landmark"}
              placeholderTextColor={AppColors.textMuted}
            />
            <PressableScale style={s.locate} onPress={props.onRelocate} disabled={locating} hitSlop={4}>
              {locating ? <ActivityIndicator color={AppColors.accent} /> : <Feather name="crosshair" size={20} color={AppColors.accent} />}
            </PressableScale>
          </View>
          {location?.coords && (
            <Text style={s.hint}>{location.coords.latitude.toFixed(5)}, {location.coords.longitude.toFixed(5)}</Text>
          )}

          <Text style={s.label}>Caption</Text>
          <TextInput
            style={[s.input, s.caption]}
            value={caption}
            onChangeText={props.onCaptionChange}
            placeholder="What's the problem? e.g. overflowing bin, dumped bags"
            placeholderTextColor={AppColors.textMuted}
            multiline
            maxLength={CAPTION_MAX}
            textAlignVertical="top"
          />
          <Text style={s.hint}>{caption.length}/{CAPTION_MAX}</Text>
        </ScrollView>

        <PressableScale haptic="medium" style={[s.submit, !canSubmit && s.disabled]} onPress={props.onSubmit} disabled={!canSubmit}>
          <Text style={s.submitText}>Submit report</Text>
        </PressableScale>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: AppColors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 12 },
  title: { fontSize: 18, fontWeight: "600", color: AppColors.text },
  body: { padding: 16, gap: 8 },
  preview: { width: "100%", aspectRatio: 3 / 4, borderRadius: 16, backgroundColor: AppColors.border },
  retake: { position: "absolute", right: 12, bottom: 12, flexDirection: "row", alignItems: "center", gap: 6,
            backgroundColor: AppColors.scrim, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20 },
  retakeText: { color: AppColors.onDark, fontWeight: "600" },
  label: { marginTop: 12, fontSize: 14, fontWeight: "600", color: AppColors.text },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { backgroundColor: AppColors.surface, borderRadius: 12, borderWidth: 1, borderColor: AppColors.border,
           paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, color: AppColors.text },
  locate: { width: 48, height: 48, borderRadius: 12, backgroundColor: AppColors.surface, borderWidth: 1, borderColor: AppColors.border,
            alignItems: "center", justifyContent: "center" },
  caption: { minHeight: 110 },
  hint: { fontSize: 12, color: AppColors.textMuted },
  submit: { marginHorizontal: 24, marginBottom: 12, height: 56, borderRadius: 16, backgroundColor: AppColors.primary,
            alignItems: "center", justifyContent: "center" },
  submitText: { color: AppColors.onPrimary, fontSize: 17, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});
