import { View, StyleSheet } from "react-native";
import { useState } from "react";
import { Image } from "expo-image";

import { AppText, Button, IconButton, Screen, TextField } from "@/components/ui";
import { Colors, Layout, Radius, Sizes, Spacing, Type } from "@/theme";
import type { Coords, PhotoLocation } from "@/utils/location";
import { PinPicker } from "./pin-picker";

const CAPTION_MAX = 280;

type Props = {
  photoUri: string;
  location: PhotoLocation | null;
  locating: boolean;
  locationError: string;
  onAddressChange: (address: string) => void;
  onRelocate: () => void;
  onConfirmPin: (coords: Coords) => void;
  caption: string;
  onCaptionChange: (caption: string) => void;
  canSubmit: boolean;
  busy: boolean;
  frozen: boolean;
  error: string;
  onEditRejected?: () => void;
  onRetake: () => void;
  onSubmit: () => void;
  onClose: () => void;
};

// Photo preview + location + caption, shown after the photo is taken.
export function ReportForm(props: Props) {
  const { photoUri, location, locating, caption, canSubmit } = props;
  const coords = location?.coords;
  const [picking, setPicking] = useState(false);

  return (
    <Screen
      tabBar={false}
      keyboard
      edges={["top", "bottom"]}
      header={
        <View style={s.header}>
          <IconButton icon="x" variant="sunken" size="sm" accessibilityLabel="Close" disabled={props.busy} onPress={props.onClose} />
          <AppText variant="title">New report</AppText>
          <View style={s.headerSpacer} />
        </View>
      }
      footer={<View style={s.footer}>
        {props.error ? <AppText accessibilityRole="alert">{props.error}</AppText> : null}
        {props.onEditRejected
          ? <Button label="Edit rejected report" icon="edit" onPress={props.onEditRejected} loading={props.busy} />
          : <Button label={props.frozen ? "Retry saved upload" : "Submit report"} icon="send" onPress={props.onSubmit} loading={props.busy} disabled={!canSubmit} />}
      </View>}>
      <View>
        <Image source={{ uri: photoUri }} style={s.preview} contentFit="cover" />
        <Button label="Retake" icon="refresh-ccw" variant="secondary" size="md" onPress={props.onRetake} disabled={props.frozen} style={s.retake} />
      </View>

      <View style={s.locationRow}>
        <TextField
          label="Address or landmark (optional)"
          editable={!props.frozen}
          maxLength={500}
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
          disabled={props.frozen}
          style={s.locate}
        />
      </View>
      {props.locationError ? <AppText tone="muted">{props.locationError}</AppText> : null}
      {!coords && <AppText tone="muted">A GPS location or confirmed map pin is required to submit.</AppText>}
      <Button label={coords ? "Adjust map pin" : "Choose location on map"} icon="map-pin" variant="outline" disabled={props.frozen} onPress={() => setPicking(true)} />
      {picking && <PinPicker initial={coords ?? null} onClose={() => setPicking(false)} onConfirm={pin => { props.onConfirmPin(pin); setPicking(false); }} />}

      <TextField
        label="Caption"
        editable={!props.frozen}
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
  footer: { gap: Spacing.sm },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
            paddingHorizontal: Layout.screenPadding, paddingVertical: Spacing.md },
  headerSpacer: { width: Sizes.iconButtonSm },
  preview: { width: "100%", aspectRatio: 3 / 4, borderRadius: Radius.lg, backgroundColor: Colors.surfaceSunken },
  retake: { position: "absolute", right: Spacing.md, bottom: Spacing.md },
  locationRow: { flexDirection: "row", alignItems: "flex-start", gap: Spacing.sm },
  locate: { width: Sizes.input, height: Sizes.input, marginTop: Type.label.lineHeight + Spacing.sm }, // lines up with the input, below its label
});
