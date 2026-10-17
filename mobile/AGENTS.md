This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## UI system

Three layers; each only uses the ones above it:

1. **`src/theme/`** (import from `@/theme`): the only place colors, fonts, type scale, spacing, radii, shadows and fixed sizes are defined. `mapStyle.json` (Google map style) lives here too.
2. **`src/components/ui/`** (import from `@/components/ui`): generic building blocks: `Screen`, `ScreenHeader`, `AppText`, `Icon`, `IconCircle`, `Button`, `IconButton`, `Card`, `ListRow`, `TextField`, `SearchField`, `Badge`, `Chip`, `SegmentedControl`, `Avatar`, `EmptyState`, `ProgressBar`, `TabBar`. All visual styling lives here. Inside this folder, import siblings by path, not via the index.
3. **Feature components** (`src/components/<feature>/`) and **screens** (`src/app/`): compose the blocks. Screens hold layout only (order, gaps, padding from `Spacing`/`Layout`).

Rules:
- Outside `theme/` and `components/ui/`, never hardcode a color, `fontSize`/`fontFamily`/`fontWeight`, or a shadow. Use `<AppText variant tone>` for text and `<Icon>` for icons (don't use React Native's `Text` or `@expo/vector-icons` directly).
- Need a new look? Add a token or a variant to an existing block first; add a new block to `components/ui/` only if it'll be reused.
- Tab screens use `<Screen>` (or `useScreenPadding()` on a FlatList) so content clears the floating tab bar. Overlays that must cover the tab bar go in a `Modal`.
- Tabs are configured in `src/components/app-tabs.tsx` (title, icon, and which roles see each tab).

## Data and roles

- `src/data/` is the backend seam. Each module exposes async functions shaped like API calls (endpoint noted in comments) over demo data; screens and hooks only call those functions, never the demo arrays/stores. Connecting the backend = replacing function bodies, not touching screens.
- Live data (e.g. `assignments.ts`) also exposes an `on…Changed(listener)` subscription; hooks in `src/hooks/` refetch on it. With a backend, fire it from a push channel or polling.
- Roles (`src/auth/session.ts`): `user` reports waste; `crew` also gets the **My route** tab (session carries `crewId`); `admin` also gets **Dispatch** to plan and assign routes. Account/login lives behind the avatar (`AccountButton`) in each tab's header, not in a tab.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
