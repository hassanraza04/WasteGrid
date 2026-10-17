import { useState, type Ref } from "react";
import { View, TextInput, StyleSheet, type TextInputProps, type TextInputInstance, type StyleProp, type ViewStyle } from "react-native";

import { PressableScale } from "@/components/ui/pressable-scale";
import { Icon } from "@/components/ui/icon";
import { Colors, Radius, Shadow, Sizes, Spacing, Type } from "@/theme";

type Props = Omit<TextInputProps, "style" | "value" | "onChangeText"> & {
  value: string;
  onChangeText: (text: string) => void;
  ref?: Ref<TextInputInstance>;
  style?: StyleProp<ViewStyle>;
};

// White pill search bar with a clear button
export function SearchField({ value, onChangeText, ref, style, onFocus, onBlur, ...rest }: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={[s.bar, focused && s.focused, style]}>
      <Icon name="search" size={20} color={Colors.inkMuted} />
      <TextInput
        {...rest}
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        style={s.input}
        placeholderTextColor={Colors.inkFaint}
        selectionColor={Colors.primary}
        returnKeyType="search"
        autoCorrect={false}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      />
      {value.length > 0 && (
        <PressableScale onPress={() => onChangeText("")} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
          <Icon name="x-circle" size={Sizes.iconSm} color={Colors.inkFaint} />
        </PressableScale>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: Spacing.md, height: Sizes.input + 4, paddingHorizontal: Spacing.xl,
         borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.surface, ...Shadow.card },
  focused: { borderColor: Colors.primary },
  input: { flex: 1, ...Type.body, color: Colors.ink, paddingVertical: 0 },
});
