import { useEffect, useState } from "react";
import { View, StyleSheet, type LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomTabBarProps } from "expo-router/js-tabs";

import { PressableScale } from "@/components/ui/pressable-scale";
import { AppText } from "@/components/ui/text";
import { Colors, Layout, Radius, Shadow, Sizes, Spacing } from "@/theme";

const PADDING = 6; // gap between the bar's edge and the selected pill
const SPRING = { duration: 350, dampingRatio: 0.85 };

// Distance from the bottom of the screen to the bar
function barBottom(insetBottom: number) {
  return Math.max(insetBottom, Spacing.md) + Layout.tabBarGap;
}

/** Bottom padding a tab screen needs so its last content can scroll clear of the floating bar. */
export function useTabBarClearance() {
  const insets = useSafeAreaInsets();
  return barBottom(insets.bottom) + Sizes.tabBar + Spacing.lg;
}

// Floating pill tab bar. Icons and titles come from each Tabs.Screen's `tabBarIcon` and `title` options.
export function TabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  const [itemWidth, setItemWidth] = useState(0);
  const x = useSharedValue(0);
  const pillStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));

  useEffect(() => {
    if (itemWidth) x.set(withSpring(state.index * itemWidth, SPRING));
  }, [state.index, itemWidth, x]);

  const onLayout = (e: LayoutChangeEvent) => {
    const width = (e.nativeEvent.layout.width - PADDING * 2) / state.routes.length;
    x.set(state.index * width); // first layout: jump into place, don't slide
    setItemWidth(width);
  };

  return (
    <View style={[s.bar, { bottom: barBottom(insets.bottom) }]} onLayout={onLayout} accessibilityRole="tablist">
      {itemWidth > 0 && <Animated.View style={[s.pill, { width: itemWidth }, pillStyle]} />}

      {state.routes.map((route, index) => {
        const { options } = descriptors[route.key];
        const focused = index === state.index;
        const color = focused ? Colors.ink : Colors.inkMuted;
        const label = options.title ?? route.name;

        // Same contract as the built-in bar: listeners can cancel the switch
        const onPress = () => {
          const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
          if (!focused && !event.defaultPrevented) navigateToTab(route.key);
        };

        return (
          <PressableScale
            key={route.key}
            style={s.item}
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={label}>
            {options.tabBarIcon?.({ focused, color, size: Sizes.icon })}
            <AppText variant="micro" style={{ color }}>{label}</AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  bar: { position: "absolute", left: Layout.screenPadding, right: Layout.screenPadding, height: Sizes.tabBar,
         flexDirection: "row", padding: PADDING, borderRadius: Radius.pill, backgroundColor: Colors.surface, ...Shadow.floating },
  pill: { position: "absolute", top: PADDING, bottom: PADDING, left: PADDING, borderRadius: Radius.pill, backgroundColor: Colors.surfaceSunken },
  item: { flex: 1, alignItems: "center", justifyContent: "center", gap: Spacing.xxs },
});
