import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, button, deferred, load, mount, native, theme, ui, wrap } from './helpers/render.mjs';

test('GPS permission denial returns no coordinates; a valid fix preserves an optional readable address', async () => {
 let permission = 'denied', fixes = 0;
 const location = load('utils/location.ts', { 'expo-location': {
  Accuracy: { Highest: 6, Balanced: 3 }, requestForegroundPermissionsAsync: async () => ({ status: permission }),
  getLastKnownPositionAsync: async () => null,
  getCurrentPositionAsync: async () => { fixes++; return { coords: { latitude: 24.9, longitude: 67.1 } }; },
  reverseGeocodeAsync: async () => [{ name: 'Landmark', district: 'Area', city: 'Karachi' }],
 } });
 assert.equal(await location.getPhotoLocation(), null); assert.equal(fixes, 0);
 permission = 'granted';
 assert.deepEqual(await location.getPhotoLocation(), { coords: { latitude: 24.9, longitude: 67.1 }, address: 'Landmark, Area, Karachi' });
});

test('photo GPS attempts time out even when a cached-location lookup stalls', async context => {
 context.mock.timers.enable({ apis: ['setTimeout'] });
 const location = load('utils/location.ts', { 'expo-location': {
  Accuracy: { Highest: 6, Balanced: 3 }, requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
  getLastKnownPositionAsync: () => new Promise(() => {}),
 } });
 const pending = location.getPhotoLocation();
 await Promise.resolve(); await Promise.resolve(); context.mock.timers.tick(15000);
 assert.equal(await pending, null);
});
test('denied GPS exposes manual selection and a confirmed pin ignores a late GPS fix', async () => {
 const client = await import('../src/services/report-client.ts');
 const requests = []; let form, camera;
 const Report = load('app/report.tsx', {
  'expo-router': { router: { replace() {}, back() {} } },
  '@/services/reports': { createDraft: async () => {}, sendDraft: async () => {}, discardDraft: async () => {} },
  '@/services/report-client': client,
  '@/auth/session': { getSession: () => null, useSession: () => null },
  '@/components/report/camera-step': { CameraStep: props => { camera = props; return null; } },
  '@/components/report/report-form': { ReportForm: props => { form = props; return null; } },
  '@/components/report/submission-receipt': { SubmissionReceipt: () => null },
  '@/utils/location': { getPhotoLocation: () => { const pending = deferred(); requests.push(pending); return pending.promise; } },
 }).default;
 const view = mount(Report, {});
 try {
  await view.render(); await act(() => camera.onCapture('file:///photo.jpg'));
  await act(async () => requests[0].resolve(null));
  assert.match(form.locationError, /choose and confirm a map pin/);
  await act(() => form.onRelocate());
  await act(() => { form.onAddressChange('Resident landmark'); form.onConfirmPin({ latitude: 24.9, longitude: 67.1 }); form.onCaptionChange('Waste'); });
  assert.equal(form.canSubmit, true);
  await act(async () => requests[1].resolve({ coords: { latitude: 31, longitude: 74 }, address: 'Wrong late GPS' }));
  assert.deepEqual(form.location, { coords: { latitude: 24.9, longitude: 67.1 }, address: 'Resident landmark' });
  assert.equal(form.locating, false);
 } finally { await view.close(); }
});
test('map bridge rejects invalid events and the map discloses attribution without app-private data', () => {
 const map = load('components/report/pin-map-html.ts', { '@/theme': { Colors: { surfaceSunken: '#eee', onPrimary: '#fff', primary: '#080' } } });
 assert.deepEqual(map.readMapMessage(JSON.stringify({ type: 'pin', latitude: 0, longitude: 180 })), { latitude: 0, longitude: 180 });
 for (const value of ['invalid', JSON.stringify({ type: 'pin', latitude: 91, longitude: 67 }), JSON.stringify({ type: 'pin', latitude: '24', longitude: 67 }), JSON.stringify({ type: 'unrelated' })]) assert.equal(map.readMapMessage(value), null);
 const html = map.pinMapHtml({ latitude: 24.9, longitude: 67.1 });
 assert.match(html, /https:\/\/tile.openstreetmap.org\/\{z\}\/\{x\}\/\{y\}.png/);
 assert.match(html, /OpenStreetMap/);
 assert.ok(!html.includes('resident-token'));
});

test('pin picker requires an explicit tap and loaded map before confirming coordinates', async () => {
 let map, result;
 const { PinPicker } = load('components/report/pin-picker.tsx', {
  'react-native': native, '@/components/ui': { ...ui, Screen: wrap }, '@/theme': { ...theme, Sizes: { mapPicker: 360 } },
  '@/utils/map': { DEFAULT_REGION: { latitude: 24.8, longitude: 67 } },
  './pin-map': { PinMap: props => { map = props; return null; } },
 });
 const initial = { latitude: 24.9, longitude: 67.1 };
 const view = mount(PinPicker, { initial, onConfirm: value => { result = value; }, onClose() {} });
 try {
  await view.render(); assert.equal(button(view.container, 'Confirm this pin').disabled, true);
  await act(() => map.onReady()); assert.equal(button(view.container, 'Confirm this pin').disabled, true);
  await act(() => map.onPin({ latitude: 25, longitude: 68 }));
  await act(() => button(view.container, 'Confirm this pin').click());
  assert.deepEqual(result, { latitude: 25, longitude: 68 });
  await act(() => map.onError());
  assert.equal(button(view.container, 'Confirm this pin').disabled, true);
 } finally { await view.close(); }
});
