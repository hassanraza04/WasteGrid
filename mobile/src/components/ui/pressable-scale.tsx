import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

import { tap, type HapticStrength } from "@/utils/haptics";

// The feel of every button in the app — tune here
const PRESSED_SCALE = 0.96;
const SPRING = { duration: 100, dampingRatio: 1 }; // quick and firm, no wobble

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type Props = Omit<PressableProps, "style"> & {
  style?: StyleProp<ViewStyle>;
  haptic?: HapticStrength | "none";
};

// Pressable that shrinks the moment a finger lands and taps the haptic engine when the press completes.
// Disabled buttons get neither (Pressable skips press events while disabled).
export function PressableScale({ style, haptic = "light", onPressIn, onPressOut, onPress, ...rest }: Props) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  return (
    <AnimatedPressable
      {...rest}
      style={[style, animatedStyle]}
      onPressIn={(e) => {
        scale.set(withSpring(PRESSED_SCALE, SPRING));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withSpring(1, SPRING));
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic !== "none") tap(haptic); // on release, so scrolling past a button doesn't buzz
        onPress?.(e);
      }}
    />
  );
}
