import type { ReactNode } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";

import { useTabBarClearance } from "@/components/ui/tab-bar";
import { Colors, Layout, Spacing } from "@/theme";

/** Padding for a screen's scrolling content. Use it on a FlatList's contentContainerStyle when not using <Screen scroll>. */
export function useScreenPadding(withTabBar = true) {
  const clearance = useTabBarClearance();
  return { paddingHorizontal: Layout.screenPadding, paddingTop: Spacing.lg, paddingBottom: withTabBar ? clearance : Spacing.xxl };
}

type Props = {
  children: ReactNode;
  scroll?: boolean; // wrap children in a padded ScrollView (default). Off for screens that bring their own list or map.
  tabBar?: boolean; // leave room for the floating tab bar (default). Off for modals.
  edges?: Edge[];
  keyboard?: boolean; // lift content above the keyboard, for screens with inputs
  header?: ReactNode; // fixed above the scrolling content
  footer?: ReactNode; // fixed below the scrolling content, e.g. a submit button
  contentStyle?: StyleProp<ViewStyle>;
};

// Every screen's frame: grey background, safe areas, standard padding and spacing between sections.
export function Screen({ children, scroll = true, tabBar = true, edges = ["top"], keyboard, header, footer, contentStyle }: Props) {
  const padding = useScreenPadding(tabBar);

  const body = (
    <SafeAreaView edges={edges} style={s.flex}>
      {header}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[padding, s.content, contentStyle]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {children}
        </ScrollView>
      ) : (
        <View style={[s.flex, contentStyle]}>{children}</View>
      )}
      {footer && <View style={s.footer}>{footer}</View>}
    </SafeAreaView>
  );

  return keyboard ? (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === "ios" ? "padding" : undefined}>{body}</KeyboardAvoidingView>
  ) : (
    <View style={s.container}>{body}</View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: Colors.background },
  content: { gap: Spacing.lg },
  footer: { paddingHorizontal: Layout.screenPadding, paddingTop: Spacing.md, paddingBottom: Spacing.md },
});
