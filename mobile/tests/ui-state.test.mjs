import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, wrap, native, theme, ui, load, deferred, mount, button } from './helpers/render.mjs';
const { RoutePlannerOverlay } = load('components/admin/route-planner-overlay.tsx', {
 'react-native': native,
 'react-native-reanimated': { __esModule: true, default: { View: wrap }, SlideInDown: { duration: () => ({}) } },
 'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
 '@/components/ui': ui, '@/theme': theme,
 '@/hooks/use-latest-request': load('hooks/use-latest-request.ts'),
 '@/utils/route-planner': { DEFAULT_CONSTRAINTS: { hours: 2, maxStopsPerCrew: 10, returnToStart: true } },
});
test('planner locks selection during calculation and clears routes when inputs change', async () => {
 const pending = deferred(); const requests = []; let assigned;
 const route = [{ crewId: 'A', stops: [{ reportId: 'job' }], distanceKm: 1, durationMin: 5 }];
 const view = mount(RoutePlannerOverlay, {
  visible: true, city: { id: 'karachi', name: 'Karachi' }, crews: [{ id: 'A', name: 'Crew A', onDuty: true }, { id: 'B', name: 'Crew B', onDuty: true }],
  onClose() {}, onCalculate(request) { requests.push(request); return requests.length === 1 ? pending.promise : Promise.resolve(route); }, onAssign: async value => { assigned = value; },
 });
 try {
  await view.render();
  await act(() => button(view.container, 'Calculate routes').click());
  assert.equal(button(view.container, 'Crew B').disabled, true);
  await act(() => button(view.container, 'Crew B').click());
  assert.equal(button(view.container, 'Crew B').dataset.selected, 'true');
  await act(async () => pending.resolve([{ ...route[0], crewId: 'B' }]));
  await act(() => button(view.container, 'Crew B').click());
  assert.equal(view.container.textContent.includes('Assign route'), false);
  assert.equal(button(view.container, 'Crew B').dataset.selected, 'false');
  await act(async () => button(view.container, 'Calculate routes').click());
  assert.deepEqual(requests[1].crewIds, ['A']);
  await act(async () => button(view.container, 'Assign route').click());
  assert.deepEqual(assigned, route);
 } finally { await view.close(); }
});
test('route calculation failure is visible and allows a retry', async () => {
 const view = mount(RoutePlannerOverlay, { visible: true, city: { id: 'karachi' }, crews: [{ id: 'A', name: 'A', onDuty: true }], onClose() {}, onAssign: async () => {}, onCalculate: async () => { throw new Error('offline'); } });
 try {
  await view.render(); await act(async () => button(view.container, 'Calculate routes').click());
  assert.match(view.container.textContent, /Unable to calculate routes/);
  assert.equal(button(view.container, 'Calculate routes').disabled, false);
 } finally { await view.close(); }
});
test('route map refits on reassignment and accepts an empty route', async () => {
 const fits = []; const api = { fitToCoordinates: coords => fits.push(coords) };
 const MapView = props => {
  React.useImperativeHandle(props.ref, () => api, []);
  React.useEffect(() => { props.onMapReady(); }, []);
  return React.createElement('div', null, props.children);
 };
 const { RouteMap } = load('components/route/route-map.tsx', {
  'react-native': native, 'react-native-maps': { __esModule: true, default: MapView, Marker: wrap, Polyline: wrap, PROVIDER_GOOGLE: 'google' },
  '@/theme/mapStyle.json': [], '@/components/route/stop-marker': { StopMarker: wrap }, '@/theme': theme,
  '@/utils/map': { DEFAULT_REGION: { latitude: 24, longitude: 67 }, regionAround: coords => coords },
  '@/hooks/use-fit-to-coordinates': load('hooks/use-fit-to-coordinates.ts', { '@/utils/map': load('utils/map.ts') }),
 });
 const first = [{ reportId: 'first', coords: { latitude: 24, longitude: 67 } }];
 const second = [{ reportId: 'second', coords: { latitude: 31, longitude: 74 } }];
 const view = mount(RouteMap, { stops: first });
 try {
  await view.render(); await view.render({ stops: second });
  assert.deepEqual(fits, [first.map(stop => stop.coords), second.map(stop => stop.coords)]);
  await view.render({ stops: [] });
  assert.equal(fits.length, 2);
 } finally { await view.close(); }
});
test('statistics never expose old-city data under a new city or period while loading', async () => {
 const requests = [];
 const { useCityStats } = load('hooks/use-city-stats.ts', { '@/data/stats': { getCityStats() { const request = deferred(); requests.push(request); return request.promise; } } });
 let result;
 function Probe(props) { result = useCityStats(props.city, props.period); return null; }
 const view = mount(Probe, { city: { id: 'karachi' }, period: '7d' });
 try {
  await view.render(); await act(async () => requests[0].resolve({ reportsMade: 240 }));
  assert.equal(result.data.stats.reportsMade, 240);
  await view.render({ city: { id: 'lahore' }, period: '30d' });
  assert.equal(result.loading, true);
  assert.equal(result.data.city.id, 'karachi'); assert.equal(result.data.period, '7d');
  assert.equal(result.data.stats.reportsMade, 240);
  await act(async () => requests[1].resolve({ reportsMade: 190 }));
  assert.equal(result.data.stats.reportsMade, 190);
 } finally { await view.close(); }
});

test('report screen requires a confirmed pin and unlocks rejected drafts for correction', async () => {
 const { ReportRejectedError } = await import('../src/services/report-client.ts');
 const client = await import('../src/services/report-client.ts');
 let form, camera, sentFields, discarded = false;
 const Report = load('app/report.tsx', {
  'expo-router': { router: { replace() {}, back() {} } },
  '@/services/reports': {
   createDraft: async (photoUri, fields) => { sentFields = fields; return { id: 'draft', photoUri, fields }; },
   sendDraft: async () => { throw new ReportRejectedError('Photo rejected', 413); },
   discardDraft: async () => { discarded = true; },
  },
  '@/services/report-client': client,
  '@/components/report/camera-step': { CameraStep: props => { camera = props; return null; } },
  '@/components/report/report-form': { ReportForm: props => { form = props; return null; } },
  '@/utils/describe-photo': { describePhoto: async () => null },
  '@/utils/location': { getPhotoLocation: async () => null },
 }).default;
 const view = mount(Report, {});
 try {
  await view.render(); await act(async () => camera.onCapture('file:///photo.jpg'));
  await act(() => { form.onCaptionChange('Overflowing bin'); form.onAddressChange('12 Main Street'); });
  assert.equal(form.canSubmit, false);
  await act(() => form.onConfirmPin({ latitude: 24.8, longitude: 67 }));
  assert.equal(form.canSubmit, true);
  await act(async () => form.onSubmit());
  assert.equal(sentFields.address, '12 Main Street'); assert.equal(sentFields.latitude, '24.8');
  assert.equal(form.frozen, true); assert.equal(form.canSubmit, false); assert.equal(typeof form.onEditRejected, 'function');
  await act(async () => form.onEditRejected());
  assert.equal(discarded, true); assert.equal(form.frozen, false); assert.equal(form.canSubmit, true);
  assert.equal(form.caption, 'Overflowing bin');
 } finally { await view.close(); }
});


test('retaking clears the first photo location and requires a fresh fix or confirmed map pin', async () => {
 const client = await import('../src/services/report-client.ts');
 const requests = []; let form, camera, submitted;
 const Report = load('app/report.tsx', {
  'expo-router': { router: { replace() {}, back() {} } },
  '@/services/reports': {
   createDraft: async (photoUri, fields) => { submitted = { photoUri, fields }; return { id: 'draft', photoUri, fields }; },
   sendDraft: async () => {}, discardDraft: async () => {},
  },
  '@/services/report-client': client,
  '@/components/report/camera-step': { CameraStep: props => { camera = props; return null; } },
  '@/components/report/report-form': { ReportForm: props => { form = props; return null; } },
  '@/utils/describe-photo': { describePhoto: async () => null },
  '@/utils/location': { getPhotoLocation: () => { const request = deferred(); requests.push(request); return request.promise; } },
 }).default;
 const view = mount(Report, {});
 try {
  await view.render(); await act(() => camera.onCapture('file:///first.jpg'));
  await act(async () => requests[0].resolve({ coords: { latitude: 24, longitude: 67 }, address: 'Old location' }));
  await act(() => form.onCaptionChange('Overflowing bin')); assert.equal(form.canSubmit, true);
  // Leave an old relocation request pending across the retake too.
  await act(() => form.onRelocate());
  await act(() => form.onRetake()); await act(() => camera.onCapture('file:///second.jpg'));
  assert.equal(form.location, null); assert.equal(form.canSubmit, false);
  await act(async () => requests[2].resolve(null)); // GPS fails for the second photo.
  await act(async () => requests[1].resolve({ coords: { latitude: 25, longitude: 68 }, address: 'Late old location' }));
  assert.equal(form.location, null); assert.equal(form.canSubmit, false);
  await act(async () => form.onSubmit()); assert.equal(submitted, undefined);
  await act(() => form.onAddressChange('Explicit new address')); assert.equal(form.canSubmit, false);
  await act(() => form.onConfirmPin({ latitude: 24.1, longitude: 67.1 })); assert.equal(form.canSubmit, true);
  await act(async () => form.onSubmit());
  assert.equal(submitted.photoUri, 'file:///second.jpg'); assert.equal(submitted.fields.address, 'Explicit new address');
  assert.equal(submitted.fields.latitude, '24.1'); assert.equal(submitted.fields.longitude, '67.1');
 } finally { await view.close(); }
});
