import { View, StyleSheet } from "react-native";
import { Image } from "expo-image";

import { AppText, Button, IconButton, Screen, TextField } from "@/components/ui";
import { Colors, Layout, Radius, Sizes, Spacing, Type } from "@/theme";
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
  describing: boolean;
  onGenerateCaption: () => void;
  canSubmit: boolean;
  onRetake: () => void;
  onSubmit: () => void;
  onClose: () => void;
};

// Photo preview + location + caption, shown after the photo is taken.
export function ReportForm(props: Props) {
  const { photoUri, location, locating, caption, describing, canSubmit } = props;
  const coords = location?.coords;

  return (
    <Screen
      tabBar={false}
      keyboard
      edges={["top", "bottom"]}
      header={
        <View style={s.header}>
          <IconButton icon="x" variant="sunken" size="sm" accessibilityLabel="Close" onPress={props.onClose} />
          <AppText variant="title">New report</AppText>
          <View style={s.headerSpacer} />
        </View>
      }
      footer={<Button label="Submit report" icon="send" onPress={props.onSubmit} disabled={!canSubmit} />}>
      <View>
        <Image source={{ uri: photoUri }} style={s.preview} contentFit="cover" />
        <Button label="Retake" icon="refresh-ccw" variant="secondary" size="md" onPress={props.onRetake} style={s.retake} />
      </View>

      <View style={s.locationRow}>
        <TextField
          label="Location"
          style={s.flex}
          value={location?.address ?? ""}
          onChangeText={props.onAddressChange}
          placeholder={locating ? "Finding your location…" : "Street, area or landmark"}
          hint={coords ? `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}` : undefined}
        />
        <IconButton
          icon="crosshair"
          variant="surface"
          accessibilityLabel="Use my current location"
          onPress={props.onRelocate}
          loading={locating}
          style={s.locate}
        />
      </View>

      <TextField
        label="Caption"
        labelAction={
          <Button
            label={describing ? "Describing…" : "Describe photo"}
            icon="zap"
            variant="ghost"
            onPress={props.onGenerateCaption}
            loading={describing}
          />
        }
        value={caption}
        onChangeText={props.onCaptionChange}
        placeholder="What's the problem? e.g. overflowing bin, dumped bags"
        multiline
        maxLength={CAPTION_MAX}
        hint={`${caption.length}/${CAPTION_MAX}`}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
            paddingHorizontal: Layout.screenPadding, paddingVertical: Spacing.md },
  headerSpacer: { width: Sizes.iconButtonSm },
  preview: { width: "100%", aspectRatio: 3 / 4, borderRadius: Radius.lg, backgroundColor: Colors.surfaceSunken },
  retake: { position: "absolute", right: Spacing.md, bottom: Spacing.md },
  locationRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
  locate: { width: Sizes.input, height: Sizes.input, marginTop: Type.label.lineHeight + Spacing.sm }, // lines up with the input, below its label
});
