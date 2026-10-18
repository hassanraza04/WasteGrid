import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, button, deferred, load, mount, native, theme, ui, wrap } from './helpers/render.mjs';

const resident = { userId: 'resident', role: 'user' };
const crew = { userId: 'crew', role: 'crew' };
const saved = (id, ownerId = resident.userId, confirmed = true) => ({
 id, ownerId, fields: { title: `Report ${id}` }, ...(confirmed ? { reference: `WG-${id}` } : {}),
});
const result = (id, status = 'completed') => ({
 id, public_reference: `WG-${id}`, display_status: status, assessment_status: 'assessed', completion_photo_ids: [`cleanup-${id}`],
});
function setup({ drafts = [saved('one')], refresh = async draft => result(draft.id), list } = {}) {
 let session = resident, focused = true;
 const reads = [], uploads = [], mutations = [];
 const services = {
  listDrafts: async () => list ? list(session) : drafts.filter(draft => draft.ownerId === session?.userId),
  countUnclaimedDrafts: async () => 0,
  refreshReport: async draft => { reads.push(draft.id); return refresh(draft); },
  sendDraft: async draft => { uploads.push(draft.id); return result(draft.id); },
  claimDeviceDrafts: async () => mutations.push('claim'), discardDraft: async () => mutations.push('discard'),
 };
 const Reports = load('app/(tabs)/reports.tsx', {
  'react-native': { ...native, ActivityIndicator: () => React.createElement('span', null, 'Loading'), Alert: { alert() {} } },
  'expo-router': { router: { push() {} }, useFocusEffect: callback => React.useEffect(() => focused ? callback() : undefined, [callback, focused]) },
  '@/components/ui': { ...ui, Card: wrap, Screen: wrap, ScreenHeader: ({ title }) => React.createElement('h1', null, title), EmptyState: ({ title }) => React.createElement('p', null, title) },
  '@/components/reports/report-details': { ReportDetails: ({ report }) => React.createElement('div', null, `Evidence: ${report.completion_photo_ids.join(',')}`) },
  '@/components/account/account-button': { AccountButton: () => null },
  '@/auth/session': { getSession: () => session, useSession: () => session },
  '@/services/reports': services, '@/theme': theme,
 }).default;
 const view = mount(Reports, {});
 return { view, reads, uploads, mutations, drafts,
  setSession: value => { session = value; },
  async focus(value) { focused = value; await view.render(); },
 };
}

test('history focus refreshes accepted statuses and cleanup evidence without retrying unsent or rejected uploads', async () => {
 const app = setup({ drafts: [saved('accepted'), saved('unsent', resident.userId, false), { ...saved('rejected', resident.userId, false), rejection: 'Rejected photo' }] });
 try {
  await app.view.render();
  assert.deepEqual(app.reads, ['accepted']);
  assert.match(app.view.container.textContent, /Status: completed/);
  assert.match(app.view.container.textContent, /Evidence: cleanup-accepted/);
  assert.match(app.view.container.textContent, /Saved on device — upload not confirmed/);
  assert.deepEqual(app.uploads, []); assert.deepEqual(app.mutations, []);
  assert.equal(button(app.view.container, 'Retry saved upload').disabled, false);
 } finally { await app.view.close(); }
});

test('refocusing keeps prior private evidence while loading and after a transient status failure', async () => {
 const pending = deferred(); let count = 0;
 const app = setup({ refresh: () => ++count === 1 ? result('one') : pending.promise });
 try {
  await app.view.render(); await app.focus(false); await app.focus(true);
  assert.equal(app.reads.length, 2);
  assert.match(app.view.container.textContent, /Evidence: cleanup-one/);
  assert.equal(button(app.view.container, 'Check status').disabled, true);
  await act(async () => pending.reject(new Error('Network unavailable')));
  assert.match(app.view.container.textContent, /Evidence: cleanup-one/);
  assert.match(app.view.container.textContent, /Some report statuses could not be refreshed/);
  assert.equal(button(app.view.container, 'Check status').disabled, false);
 } finally { await app.view.close(); }
});

test('a missing accepted report clears its obsolete status without removing the saved draft', async () => {
 let exists = true;
 const app = setup({ refresh: draft => exists ? result(draft.id) : null });
 try {
  await app.view.render(); exists = false; await app.focus(false); await app.focus(true);
  assert.doesNotMatch(app.view.container.textContent, /Status: completed|Evidence:/);
  assert.match(app.view.container.textContent, /WG-one/);
  assert.match(app.view.container.textContent, /Some report statuses could not be refreshed/);
  assert.deepEqual(app.mutations, []);
 } finally { await app.view.close(); }
});

test('resident to crew to resident on one device hides old-account responses and refreshes retained evidence', async () => {
 const old = deferred(); let count = 0;
 const app = setup({ drafts: [saved('resident-report'), saved('crew-report', crew.userId)], refresh: draft => draft.id === 'resident-report' && ++count === 1 ? old.promise : result(draft.id) });
 try {
  await app.view.render();
  app.setSession(null); await app.view.render();
  assert.match(app.view.container.textContent, /Log in to see your reports/);
  app.setSession(crew); await app.view.render();
  assert.match(app.view.container.textContent, /Evidence: cleanup-crew-report/);
  assert.doesNotMatch(app.view.container.textContent, /resident-report/);
  await act(async () => old.resolve(result('resident-report')));
  assert.doesNotMatch(app.view.container.textContent, /resident-report/);
  app.setSession(null); await app.view.render(); app.setSession(resident); await app.view.render();
  assert.match(app.view.container.textContent, /Evidence: cleanup-resident-report/);
  assert.doesNotMatch(app.view.container.textContent, /crew-report/);
  assert.deepEqual(app.reads, ['resident-report', 'crew-report', 'resident-report']);
  assert.equal(app.drafts.length, 2); assert.deepEqual(app.uploads, []); assert.deepEqual(app.mutations, []);
 } finally { await app.view.close(); }
});

test('a late local list after account switch never starts another account status request', async () => {
 const old = deferred();
 const app = setup({ list: session => session?.userId === resident.userId ? old.promise : [] });
 try {
  await app.view.render(); app.setSession(crew); await app.view.render();
  await act(async () => old.resolve([saved('private')]));
  assert.deepEqual(app.reads, []);
  assert.doesNotMatch(app.view.container.textContent, /private/);
 } finally { await app.view.close(); }
});

test('a status response from a previous focus cannot overwrite newer cleanup evidence', async () => {
 const old = deferred(); let count = 0;
 const app = setup({ refresh: () => ++count === 1 ? old.promise : result('one', 'completed') });
 try {
  await app.view.render(); await app.focus(false); await app.focus(true);
  assert.match(app.view.container.textContent, /Status: completed/);
  await act(async () => old.resolve(result('one', 'assigned')));
  assert.match(app.view.container.textContent, /Status: completed/);
  assert.doesNotMatch(app.view.container.textContent, /Status: assigned/);
 } finally { await app.view.close(); }
});
