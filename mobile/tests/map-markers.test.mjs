import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, button, load, mount, native, theme, ui, wrap } from './helpers/render.mjs';

test('map feed requests the viewport without credentials and validates its response', async () => {
  const { mapBounds, readMapMarkers } = load('services/map-markers.ts');
  const region = { latitude: 24.92, longitude: 67.09, latitudeDelta: 0.02, longitudeDelta: 0.04 };
  const bounds = mapBounds(region);
  assert.ok(Math.abs(bounds.south - 24.91) < 0.000001);
  assert.ok(Math.abs(bounds.north - 24.93) < 0.000001);
  assert.ok(Math.abs(bounds.west - 67.07) < 0.000001);
  assert.ok(Math.abs(bounds.east - 67.11) < 0.000001);
  const wrapped = mapBounds({ latitude: 0, longitude: 179.99, latitudeDelta: 0.02, longitudeDelta: 0.04 });
  assert.ok(wrapped.west > wrapped.east); // The API accepts an antimeridian-crossing viewport.
  const previous = process.env.EXPO_PUBLIC_API_BASE_URL;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example/';
  try {
    let requested;
    const page = await readMapMarkers(region, async (url, options) => {
      requested = { url, options };
      return { ok: true, json: async () => ({ items: [{ latitude: 24.921, longitude: 67.091 }], truncated: false }) };
    });
    assert.equal(new URL(requested.url).pathname, '/map/markers');
    assert.ok(Math.abs(Number(new URL(requested.url).searchParams.get('south')) - 24.91) < 0.000001);
    assert.equal(requested.options.headers, undefined);
    assert.equal(page.items.length, 1);
    await assert.rejects(readMapMarkers(region, async () => ({ ok: true, json: async () => ({ items: [{ latitude: 999, longitude: 0 }], truncated: false }) })), /Unable to read/);
  } finally {
    if (previous === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
    else process.env.EXPO_PUBLIC_API_BASE_URL = previous;
  }
});

test('map refresh replaces accepted markers and removes completed locations', async () => {
  let next = { items: [{ latitude: 24.921, longitude: 67.091 }], truncated: false };
  let onAppState;
  const start = { region: { latitude: 24.92, longitude: 67.09, latitudeDelta: 0.02, longitudeDelta: 0.02 }, locateLater: false };
  const MapView = React.forwardRef(({ children }, _ref) => React.createElement('div', null, children));
  const MapPage = load('app/(tabs)/index.tsx', {
    'react-native': { ...native, AppState: { currentState: 'active', addEventListener: (_event, callback) => { onAppState = callback; return { remove() { onAppState = undefined; } }; } }, ActivityIndicator: wrap },
    'react-native-maps': {
      __esModule: true, default: MapView, PROVIDER_GOOGLE: 'google',
      Marker: props => React.createElement('div', { 'data-marker': `${props.coordinate.latitude},${props.coordinate.longitude}` }, props.children),
    },
    'react-native-safe-area-context': { SafeAreaView: wrap },
    'expo-router': { router: { push() {} }, useFocusEffect: callback => React.useEffect(callback, [callback]) },
    '@/theme/mapStyle.json': [], '@/theme': { ...theme, Colors: { ink: 'black', background: 'white' }, Spacing: { sm: 4, xs: 2, md: 8 }, Layout: { screenPadding: 16 } },
    '@/components/ui': { ...ui, Card: wrap, useTabBarClearance: () => 50 },
    '@/components/account/account-button': { AccountButton: wrap },
    '@/components/map/waste-marker': { WasteMarker: () => React.createElement('span', null, 'bin') },
    '@/hooks/use-start-region': { useStartRegion: () => start },
    '@/services/map-markers': { readMapMarkers: async () => next },
    '@/utils/location': { getCurrentCoords: async () => ({ ok: false }) },
    '@/utils/map': { regionAround: value => value },
  }).default;
  const view = mount(MapPage, {});
  try {
    await view.render();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 275)); });
    assert.equal(view.container.querySelectorAll('[data-marker]').length, 1);
    next = { items: [], truncated: false };
    await act(async () => { onAppState('active'); await Promise.resolve(); });
    assert.equal(view.container.querySelectorAll('[data-marker]').length, 0);
    await act(async () => button(view.container, 'refresh-cw').click());
  } finally { await view.close(); }
});
