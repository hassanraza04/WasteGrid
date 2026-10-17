import Feather from "@expo/vector-icons/Feather"; // direct import: bundles only the Feather font

import { Colors, Sizes } from "@/theme";

export type IconName = keyof typeof Feather.glyphMap;

type Props = { name: IconName; size?: number; color?: string };

// The app's icon set. Swap the library here and every icon follows.
export function Icon({ name, size = Sizes.icon, color = Colors.ink }: Props) {
  return <Feather name={name} size={size} color={color} />;
}
