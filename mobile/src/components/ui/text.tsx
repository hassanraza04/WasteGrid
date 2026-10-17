import { Text, type TextProps } from "react-native";

import { Colors, Tones, Type, type TypeVariant } from "@/theme";

const TEXT_TONES = {
  default: Colors.ink,
  muted: Colors.inkMuted,
  faint: Colors.inkFaint,
  primary: Colors.primary,
  inverse: Colors.onPrimary,
  inverseMuted: Colors.onDarkMuted,
  warning: Tones.warning.fg,
  info: Tones.info.fg,
} as const;

export type TextTone = keyof typeof TEXT_TONES;

type Props = TextProps & {
  variant?: TypeVariant;
  tone?: TextTone;
  align?: "left" | "center" | "right";
};

// Every piece of text in the app. Pick a variant from the type scale and a tone; avoid styling fonts by hand.
export function AppText({ variant = "body", tone = "default", align, style, ...rest }: Props) {
  return <Text {...rest} style={[Type[variant], { color: TEXT_TONES[tone] }, align && { textAlign: align }, style]} />;
}
