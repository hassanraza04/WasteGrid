import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { Colors, useAppFonts } from '@/theme';

SplashScreen.preventAutoHideAsync();

// The app is light-only for now, so navigation always uses the light theme on our grey background
const NavigationTheme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, background: Colors.background, primary: Colors.primary, text: Colors.ink },
};

export default function RootLayout() {
  const fontsReady = useAppFonts();
  if (!fontsReady) return null; // native splash stays up until the fonts are in

  return (
    <ThemeProvider value={NavigationTheme}>
      <StatusBar style="dark" />
      <AnimatedSplashOverlay />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="report" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="login" options={{ presentation: 'modal' }} />
      </Stack>
    </ThemeProvider>
  );
}
