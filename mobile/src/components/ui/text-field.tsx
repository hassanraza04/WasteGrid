import { useState, type ReactNode, type Ref } from "react";
import { View, TextInput, StyleSheet, type TextInputProps, type TextInputInstance, type StyleProp, type ViewStyle } from "react-native";

import { AppText } from "@/components/ui/text";
import { Colors, Radius, Sizes, Spacing, Type } from "@/theme";

type Props = Omit<TextInputProps, "style"> & {
  label?: string;
  labelAction?: ReactNode; // shown at the right end of the label line, e.g. a "Describe photo" button
  hint?: string; // small muted line under the field
  ref?: Ref<TextInputInstance>;
  style?: StyleProp<ViewStyle>; // the wrapper (label + field + hint)
};

// Labelled text input. Highlights in green while focused.
export function TextField({ label, labelAction, hint, ref, style, multiline, onFocus, onBlur, ...rest }: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[s.wrapper, style]}>
      {(label || labelAction) && (
        <View style={s.labelRow}>
          {label && <AppText variant="label" style={s.label}>{label}</AppText>}
          {labelAction}
        </View>
      )}
      <TextInput
        {...rest}
        ref={ref}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        placeholderTextColor={Colors.inkFaint}
        selectionColor={Colors.primary}
        style={[s.input, multiline && s.multiline, focused && s.focused]}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      />
      {hint && <AppText variant="caption" tone="muted" style={s.hint}>{hint}</AppText>}
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: { gap: Spacing.sm },
  labelRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: Spacing.xs },
  label: { flex: 1 },
  input: { ...Type.body, color: Colors.ink, backgroundColor: Colors.surface, minHeight: Sizes.input, borderRadius: Radius.md,
           paddingHorizontal: Spacing.xl, borderWidth: 1.5, borderColor: Colors.surface },
  multiline: { minHeight: 120, paddingTop: Spacing.lg, paddingBottom: Spacing.lg },
  focused: { borderColor: Colors.primary },
  hint: { paddingHorizontal: Spacing.xs },
});
