import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as client from '../src/services/phone-updates-client.ts';
import { act, button, deferred, load, mount, native, theme, ui } from './helpers/render.mjs';
const draft = { id: 'report-a', ownerId: 'owner-a' };
const initial = { enabled: true, phone_label: 'Registered phone ending 1234', latest_request: null, pending: false };
const receipt = status => ({ id: '00000000-0000-4000-8000-000000000001', status, message: 'Cleanup is in progress.', created_at: '2026-10-18T00:00:00Z' });
function setup(overrides = {}) {
 let owner = 'owner-a', listener, state = initial, field;
 const sent = [], reads = [];
 const { ReportMessaging } = load('components/reports/report-messaging.tsx', {
  'react-native': { ...native, AppState: { addEventListener: (_event, callback) => { listener = callback; return { remove() { listener = undefined; } }; } } },
  '@/components/ui': { ...ui, Card: native.View, TextField: props => { field = props; return React.createElement('input', { placeholder: props.placeholder, value: props.value, disabled: !props.editable, onChange: () => {} }); } },
  '@/theme': theme, '@/services/phone-updates-client': client,
  '@/services/reports': {
   phoneUpdates: async value => { reads.push(value.id); return overrides.phoneUpdates ? overrides.phoneUpdates(value) : state; },
   sendPhoneUpdate: async (...args) => { sent.push(args); return overrides.sendPhoneUpdate ? overrides.sendPhoneUpdate(...args) : receipt('queued'); },
  },
  '@/auth/session': { useSession: () => owner ? { userId: owner } : null, getSession: () => owner ? { userId: owner } : null },
 });
 return { ReportMessaging, sent, reads, field: () => field, type: value => act(() => field.onChangeText(value)), owner: value => { owner = value; }, state: value => { state = value; }, foreground: () => listener?.('active') };
}
test('Phone updates starts empty, shows the registered phone, and sends normalized Status only on a user action', async () => {
 const app = setup(), view = mount(app.ReportMessaging, { draft });
 try {
  await view.render();
  assert.match(view.container.textContent, /phone ending 1234/);
  assert.equal(app.field().value, ''); assert.equal(app.field().placeholder, 'Type Status');
  assert.equal(button(view.container, 'Send').disabled, true);
  assert.match(view.container.textContent, /A copy will go to phone ending 1234/);
  assert.doesNotMatch(view.container.textContent, /iMessage|LINK|QR|Open Messages|Report conversation/);
  assert.deepEqual(app.sent, []);
  await app.type('  sTaTuS '); await act(async () => button(view.container, 'Send').click());
  assert.deepEqual(app.sent, [[draft, 'Status']]);
  assert.match(view.container.textContent, /Phone copy queued/);
  assert.doesNotMatch(view.container.textContent, /You: Status|WasteGrid reply|Check again|Checking phone updates/);
  assert.match(view.container.textContent, /Cleanup is in progress/);
  assert.doesNotMatch(view.container.textContent, /Phone copy delivered/);
  assert.equal(app.field().value, '');
 } finally { await view.close(); }
});
test('unsupported messages show clear guidance and never send', async () => {
 const app = setup(), view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await app.type('Where is the crew?');
  await act(async () => button(view.container, 'Send').click());
  assert.match(view.container.textContent, /Type "Status"/);
  assert.deepEqual(app.sent, []);
 } finally { await view.close(); }
});
test('double taps send once and foreground refresh checks delivery without sending again', async () => {
 const pending = deferred(); const app = setup({ sendPhoneUpdate: () => pending.promise });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await app.type('Status');
  await act(() => { button(view.container, 'Send').click(); button(view.container, 'Send').click(); });
  assert.equal(app.sent.length, 1);
  await act(async () => pending.resolve(receipt('queued')));
  app.state({ ...initial, latest_request: receipt('delivered') });
  await act(async () => app.foreground());
  assert.match(view.container.textContent, /Phone copy delivered/);
  assert.equal(app.sent.length, 1); assert.equal(app.reads.length, 2);
 } finally { await view.close(); }
});
test('all receipt states are honest and submitted permits a new explicit status request without claiming delivery', async () => {
 const expected = { queued: 'Phone copy queued', sending: 'Sending phone copy', submitted: 'Phone delivery pending', delivered: 'Phone copy delivered', failed: 'could not be sent', uncertain: 'Phone delivery unconfirmed', cancelled: 'cancelled' };
 for (const [status, text] of Object.entries(expected)) {
  const app = setup({ phoneUpdates: async () => ({ ...initial, latest_request: receipt(status) }) });
  const view = mount(app.ReportMessaging, { draft });
  try {
   await view.render(); assert.ok(view.container.textContent.includes(text));
   if (status !== 'delivered') assert.doesNotMatch(view.container.textContent, /Phone copy delivered/);
   await app.type('Status');
   assert.equal(button(view.container, 'Send').disabled, ['queued', 'sending', 'uncertain'].includes(status));
   assert.deepEqual(app.sent, []);
  } finally { await view.close(); }
 }
});
test('an unknown request stays saved and only an explicit retry sends the same operation', async () => {
 let attempt = 0;
 const app = setup({ sendPhoneUpdate: async () => { if (++attempt === 1) throw new client.PhoneUpdatesError('The request could not be confirmed.', 408); return receipt('submitted'); } });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await app.type('Status');
  await act(async () => button(view.container, 'Send').click());
  assert.match(view.container.textContent, /Request saved/);
  assert.equal(app.sent.length, 1);
  await act(async () => button(view.container, 'Retry request').click());
  assert.deepEqual(app.sent, [[draft, 'Status'], [draft, 'Status']]);
  assert.match(view.container.textContent, /Phone delivery pending/);
  assert.doesNotMatch(view.container.textContent, /Request saved/);
 } finally { await view.close(); }
});
test('reopening with a saved uncertain request never auto-sends and allows a same-request retry even when new sends are disabled', async () => {
 const app = setup({ phoneUpdates: async () => ({ ...initial, enabled: false, pending: true }) });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); assert.deepEqual(app.sent, []);
  assert.equal(button(view.container, 'Retry request').disabled, false);
  await act(async () => button(view.container, 'Retry request').click());
  assert.equal(app.sent.length, 1);
 } finally { await view.close(); }
});
test('disabled reports hide the empty feature while existing receipts remain visible', async () => {
 const app = setup(); app.state({ ...initial, enabled: false, phone_label: null });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); assert.equal(view.container.textContent, '');
  app.state({ ...initial, enabled: false, latest_request: receipt('submitted') });
  await act(async () => app.foreground());
  assert.match(view.container.textContent, /Phone delivery pending/);
  assert.doesNotMatch(view.container.textContent, /A copy will go/);
 } finally { await view.close(); }
});
test('refresh failure preserves an existing receipt and remains retryable', async () => {
 let calls = 0;
 const app = setup({ phoneUpdates: async () => { if (++calls === 2) throw new client.PhoneUpdatesError('Unable to check phone updates.'); return { ...initial, latest_request: receipt('submitted') }; } });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await act(async () => app.foreground());
  assert.match(view.container.textContent, /Unable to check/);
  assert.match(view.container.textContent, /Phone delivery pending/);
  await act(async () => button(view.container, 'Check again').click());
  assert.doesNotMatch(view.container.textContent, /Unable to check/); assert.deepEqual(app.sent, []);
 } finally { await view.close(); }
});
test('a 409 conflict refreshes the existing receipt instead of suggesting another send', async () => {
 const app = setup({ sendPhoneUpdate: async () => { throw new client.PhoneUpdatesError('Check delivery status.', 409); } });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); app.state({ ...initial, latest_request: receipt('sending') });
  await app.type('Status'); await act(async () => button(view.container, 'Send').click());
  assert.match(view.container.textContent, /Sending phone copy/); assert.equal(app.reads.length, 2);
  assert.equal(button(view.container, 'Send').disabled, true); assert.equal(app.sent.length, 1);
 } finally { await view.close(); }
});
test('account changes and unmounts hide late registered phone and receipt responses', async () => {
 const pending = deferred(); const app = setup({ phoneUpdates: () => pending.promise });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); app.owner('owner-b'); await view.render();
  await act(async () => pending.resolve(initial)); assert.equal(view.container.textContent, '');
 } finally { await view.close(); }
 for (const change of ['account', 'unmount']) {
  const result = deferred(); const second = setup({ sendPhoneUpdate: () => result.promise });
  const screen = mount(second.ReportMessaging, { draft });
  await screen.render(); await second.type('Status');
  await act(() => button(screen.container, 'Send').click());
  if (change === 'unmount') await screen.close(); else { second.owner('owner-b'); await screen.render(); }
  await act(async () => result.resolve(receipt('delivered')));
  if (change === 'account') { assert.equal(screen.container.textContent, ''); await screen.close(); }
 }
});


test('the reply stays compact, polling never sends again, and a delayed delivery stays recoverable', async t => {
 let now = Date.now();
 t.mock.method(Date, 'now', () => now);
 const ticks = [], realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
 t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
  if (delay === 3000) { const handle = { callback }; ticks.push(handle); return handle; }
  return realTimeout(callback, delay, ...args);
 });
 t.mock.method(globalThis, 'clearTimeout', handle => {
  const index = ticks.indexOf(handle);
  if (index >= 0) ticks.splice(index, 1); else realClear(handle);
 });
 const app = setup(), view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await app.type('Status');
  await act(async () => button(view.container, 'Send').click());
  assert.match(view.container.textContent, /Cleanup is in progress/);
  assert.match(view.container.textContent, /Phone copy queued/);
  assert.equal(app.sent.length, 1); assert.equal(ticks.length, 1);
  app.state({ ...initial, latest_request: receipt('submitted') });
  now += 90_001;
  await act(async () => ticks.shift().callback());
  assert.equal(button(view.container, 'Check again').disabled, false);
  assert.equal(app.sent.length, 1); assert.equal(ticks.length, 0);
  app.state({ ...initial, latest_request: receipt('delivered') });
  await act(async () => button(view.container, 'Check again').click());
  assert.match(view.container.textContent, /Phone copy delivered/);
  assert.equal(app.sent.length, 1); assert.equal(app.reads.length, 3);
  assert.equal(ticks.length, 0);
  assert.doesNotMatch(view.container.textContent, /Check again/);
 } finally { await view.close(); }
});
