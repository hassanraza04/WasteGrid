/**
 * Design tokens for the app: colors, fonts, spacing and layout constants.
 * Use these instead of hardcoding values in StyleSheets.
 */

import '@/global.css';

import { Platform } from 'react-native';

// ─── Colors ──────────────────────────────────────────────────────────────────

/**
 * WasteGrid palette. Every screen color comes from here, so changing a value
 * restyles the whole app. Light mode only for now; for dark mode, add a dark
 * set with the same names and read it through `useTheme()`.
 */
export const AppColors = {
  // Brand
  primary: '#17af4f', // green buttons: Report waste, Submit, Allow camera
  onPrimary: '#ffffff', // text and icons on primary buttons
  accent: '#2F6B55', // green icons and spinners

  // Text
  text: '#1E2B26',
  textMuted: '#8A9690', // placeholders, hints, counters

  // Surfaces
  background: '#F6F8F7', // screen backgrounds
  surface: '#ffffff', // cards, inputs, floating buttons
  border: '#DDE3E0', // input borders, empty image frames

  // Dark contexts (camera, text over photos)
  cameraBackground: '#000000',
  onDark: '#ffffff',
  onDarkMuted: '#bbbbbb',
  scrim: 'rgba(0,0,0,0.55)', // backing behind text drawn over photos
  backdrop: 'rgba(0,0,0,0.35)', // dims the screen behind overlays

  // Report status
  statusSubmitted: '#C27C0E',
  statusInProgress: '#2B6CB0',
  statusResolved: '#2F6B55',

  shadow: '#000000',
} as const;

/**
 * Light/dark colors for the starter's themed components (ThemedText, ThemedView, tab bar),
 * read through `useTheme()`. Light text and background follow the palette above.
 */
export const Colors = {
  light: {
    text: AppColors.text,
    background: AppColors.surface,
    backgroundElement: '#F0F0F3',
    backgroundSelected: '#E0E1E6',
    textSecondary: '#60646C',
  },
  dark: {
    text: '#ffffff',
    background: '#000000',
    backgroundElement: '#212225',
    backgroundSelected: '#2E3135',
    textSecondary: '#B0B4BA',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

// ─── Typography ──────────────────────────────────────────────────────────────

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

// ─── Spacing & layout ────────────────────────────────────────────────────────

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
