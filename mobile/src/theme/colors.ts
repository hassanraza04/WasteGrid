/**
 * WasteGrid palette. Every color on screen comes from here, so changing a value restyles the whole app.
 * Light mode only for now; for dark mode, add a second set with the same keys and pick one at runtime.
 */
export const Colors = {
  // Brand: green is for the main action and "good news" only. Everything else is ink on grey/white.
  primary: "#12804D",
  primarySoft: "#DDF1E6", // tinted backgrounds behind green icons
  onPrimary: "#FFFFFF",

  // Ink (text and icons)
  ink: "#0F141A",
  inkMuted: "#6B7480", // secondary text, inactive icons
  inkFaint: "#9AA3AD", // placeholders, disabled

  // Surfaces
  background: "#ECEFF3", // cool grey behind everything
  surface: "#FFFFFF", // cards, inputs, floating controls
  surfaceSunken: "#E3E7EC", // selected tab/segment pill, grey icon buttons, inset boxes
  hairline: "#DCE1E7", // dividers
  outline: "#C9CFD7", // outlined chips and buttons

  // Dark contexts (camera, text over photos)
  cameraBackground: "#000000",
  onDark: "#FFFFFF",
  onDarkMuted: "#B8BEC6",
  scrim: "rgba(15, 20, 26, 0.55)", // behind text drawn over photos
  backdrop: "rgba(15, 20, 26, 0.35)", // dims the screen behind sheets
} as const;

/** Foreground/background pairs for badges and status indicators. */
export const Tones = {
  neutral: { fg: Colors.inkMuted, bg: Colors.surfaceSunken },
  warning: { fg: "#9A5B00", bg: "#FBEFD9" },
  info: { fg: "#1F5FA8", bg: "#E1ECF8" },
  success: { fg: Colors.primary, bg: Colors.primarySoft },
} as const;

export type Tone = keyof typeof Tones;
