import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, button, deferred, load, mount, native, theme, ui } from './helpers/render.mjs';

const draft = { id: 'one' };
function setup(services) {
 const images = []; let onState;
 const components = load('components/reports/report-details.tsx', {
  'react-native': { ...native, AppState: { addEventListener: (_event, fn) => { onState = fn; return { remove() { onState = undefined; } }; } } },
  'expo-image': { Image: props => { images.push(props); return React.createElement('div', null, 'Private image'); } },
  '@/components/ui': ui, '@/theme': theme, '@/services/reports': services,
 });
 return { ...components, images, state: value => onState?.(value) };
}
test('history loads pages, deduplicates IDs, preserves null status and resets on refresh', async () => {
 const requests = []; let call = 0;
 const item = (id, status = null) => ({ id, message: `Update ${id}`, status, created_at: '2026-10-17T12:00:00Z' });
 const { ReportDetails } = setup({ reportUpdates: async (_draft, offset) => {
  requests.push(offset); call++;
  if (call === 1) return { items: [item('a'), item('b', 'submitted')], offset: 0, total: 4 };
  if (call === 2) return { items: [item('b', 'submitted'), item('c')], offset: 2, total: 4 };
  return { items: [item('d')], offset: 0, total: 1 };
 } });
 const view = mount(ReportDetails, { draft, report: { display_status: 'completed' } });
 try {
  await view.render();
  assert.ok(view.container.textContent.includes('Update a'));
  assert.ok(!view.container.textContent.includes('completed'));
  await act(async () => button(view.container, 'Load more updates').click());
  assert.equal(view.container.textContent.split('Update b').length - 1, 1);
  assert.ok(view.container.textContent.includes('Update c'));
  await act(async () => button(view.container, 'Refresh history').click());
  assert.ok(!view.container.textContent.includes('Update a'));
  assert.ok(view.container.textContent.includes('Update d'));
  assert.deepEqual(requests, [0, 2, 0]);
 } finally { await view.close(); }
});
test('late history from a different report cannot overwrite the newly selected report', async () => {
 const pending = deferred();
 const { ReportDetails } = setup({ reportUpdates: async d => d.id === 'one' ? pending.promise : { items: [], offset: 0, total: 0 } });
 const view = mount(ReportDetails, { draft, report: {} });
 try {
  await view.render(); await view.render({ draft: { id: 'two' }, report: {} });
  await act(async () => pending.resolve({ items: [{ id: 'old', message: 'Private old update' }], offset: 0, total: 1 }));
  assert.ok(!view.container.textContent.includes('Private old update'));
  assert.ok(view.container.textContent.includes('No updates yet'));
 } finally { await view.close(); }
});
test('private photos renew expired access, omit auth headers/disk caching and bound failed-image retries', async () => {
 let calls = 0;
 const clock = Date.now;
 let now = clock(); Date.now = () => now;
 const { PrivateReportPhoto, images, state } = setup({ reportPhoto: async () => ({ url: `https://storage.example/${++calls}`, expiresAt: now + 300000 }) });
 const view = mount(PrivateReportPhoto, { draft, photoId: 'photo', label: 'Reported photo' });
 try {
  await view.render();
  assert.deepEqual(images.at(-1).source, { uri: 'https://storage.example/1' });
  assert.equal(images.at(-1).cachePolicy, 'none');
  now += 300001;
  await act(async () => state('active')); assert.equal(calls, 2);
  await act(async () => images.at(-1).onError()); assert.equal(calls, 3);
  await act(async () => images.at(-1).onError()); assert.equal(calls, 3);
  assert.ok(view.container.textContent.includes('Photo unavailable'));
  now += 300001; await act(async () => state('active')); assert.equal(calls, 3);
  await act(async () => button(view.container, 'Retry photo').click()); assert.equal(calls, 4);
 } finally { Date.now = clock; await view.close(); }
});
