import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, button, deferred, load, mount, native, theme, ui } from './helpers/render.mjs';
const draft = { id: 'report-a', ownerId: 'owner-a' };
const initial = { enabled: true, recipient: 'pilot@example.test', links: [] };
function setup(overrides = {}) {
 let owner = 'owner-a', listener, status = initial;
 const opened = [];
 const services = {
  messagingLinks: async () => status,
  followupLink: async () => ({ link_code: 'secret_code', expires_at: new Date(Date.now() + 600000).toISOString(), recipient: 'pilot@example.test', channel: 'imessage' }),
  reportMessages: async () => ({ items: [], offset: 0, limit: 50, total: 0 }),
  unlinkReportMessaging: async () => { status = initial; }, ...overrides,
 };
 const { ReportMessaging } = load('components/reports/report-messaging.tsx', {
  'react-native': { ...native, Platform: { OS: 'ios' }, AppState: { addEventListener: (_event, fn) => { listener = fn; return { remove() { listener = undefined; } }; } } },
  'expo-linking': { openURL: async url => { opened.push(url); } },
  '@/components/ui': ui, '@/theme': theme, '@/services/reports': services,
  '@/auth/session': { useSession: () => owner ? { userId: owner } : null, getSession: () => owner ? { userId: owner } : null },
 });
 return { ReportMessaging, opened, owner: value => { owner = value; }, status: value => { status = value; }, foreground: () => listener?.('active') };
}
test('requesting or opening a link never claims success before backend binding; refresh and unlink reflect committed status', async () => {
 const app = setup(); const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render();
  await act(async () => button(view.container, 'Get iMessage updates').click());
  assert.match(view.container.textContent, /LINK secret_code/);
  assert.match(view.container.textContent, /not linked/);
  await act(async () => button(view.container, 'Open Messages').click());
  assert.match(app.opened[0], /^sms:pilot%40example.test&body=LINK%20secret_code$/);
  assert.match(view.container.textContent, /not linked/);
  app.status({ ...initial, links: [{ id: 'linked', channel: 'imessage', active: true, paused: true }] });
  await act(async () => app.foreground());
  assert.match(view.container.textContent, /updates paused/);
  assert.ok(!view.container.textContent.includes('secret_code'));
  await act(async () => button(view.container, 'Unlink this report').click());
  assert.match(view.container.textContent, /not linked/);
 } finally { await view.close(); }
});
test('expired codes are hidden and cannot open Messages', async () => {
 const original = Date.now; let now = original(); Date.now = () => now;
 const app = setup(); const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await act(async () => button(view.container, 'Get iMessage updates').click());
  now += 600001; await act(async () => app.foreground());
  assert.ok(!view.container.textContent.includes('secret_code'));
  assert.equal(app.opened.length, 0);
 } finally { Date.now = original; await view.close(); }
});
test('status failure remains retryable and never invents an active link', async () => {
 let calls = 0;
 const app = setup({ messagingLinks: async () => { if (++calls === 1) throw Error('offline'); return initial; } });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); assert.match(view.container.textContent, /temporarily unavailable/);
  assert.equal(button(view.container, 'Get iMessage updates').disabled, true);
  await act(async () => button(view.container, 'Refresh messaging status').click());
  assert.match(view.container.textContent, /not linked/);
  assert.equal(button(view.container, 'Get iMessage updates').disabled, false);
 } finally { await view.close(); }
});
test('account changes and unmounts suppress private late conversations and link codes', async () => {
 const pending = deferred();
 const app = setup({ reportMessages: () => pending.promise });
 const view = mount(app.ReportMessaging, { draft });
 try {
  await view.render(); await act(() => button(view.container, 'Refresh conversation').click());
  app.owner('owner-b'); await view.render();
  await act(async () => pending.resolve({ items: [{ id: 'm1', direction: 'inbound', body: 'Private account A text', created_at: '2026-10-17' }], offset: 0, total: 1 }));
  assert.equal(view.container.textContent, '');
 } finally { await view.close(); }
 const code = deferred(); const second = setup({ followupLink: () => code.promise });
 const screen = mount(second.ReportMessaging, { draft });
 await screen.render(); await act(() => button(screen.container, 'Get iMessage updates').click());
 await screen.close();
 await act(async () => code.resolve({ link_code: 'late_secret', expires_at: new Date(Date.now() + 600000).toISOString(), recipient: 'pilot@example.test', channel: 'imessage' }));
 assert.equal(second.opened.length, 0);
});
