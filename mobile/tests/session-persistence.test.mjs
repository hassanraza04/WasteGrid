import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, deferred } from './helpers/render.mjs';
import * as sessionClient from '../src/auth/session-client.ts';

function setup(os = 'android') {
 const secrets = new Map(); let options, event, onState;
 let starts = 0, stops = 0;
 const stored = { user: { id: 'verified-user', email: 'person@example.test' }, access_token: 'access', refresh_token: 'refresh' };
 const auth = {
  onAuthStateChange: fn => { event = fn; },
  async signInWithPassword() { if (options.auth.persistSession) await options.auth.storage.setItem('session', JSON.stringify(stored)); return { data: { user: stored.user, session: stored } }; },
  async getSession() { return { data: { session: JSON.parse(await options.auth.storage?.getItem('session') ?? 'null') } }; },
  async signOut() { await options.auth.storage?.removeItem('session'); event('SIGNED_OUT'); return {}; },
  async startAutoRefresh() { starts++; }, async stopAutoRefresh() { stops++; },
 };
 process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example'; process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://auth.example'; process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
 const reload = () => load('auth/session.ts', {
  './session-client': sessionClient,
  'react-native': { Platform: { OS: os }, AppState: { currentState: 'active', addEventListener: (_event, fn) => { onState = fn; return { remove() { onState = undefined; } }; } } },
  'expo-secure-store': { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'protected', getItemAsync: async key => secrets.get(key) ?? null,
   setItemAsync: async (key, value, config) => { assert.equal(config.keychainAccessible, 'protected'); secrets.set(key, value); }, deleteItemAsync: async key => { secrets.delete(key); } },
  '@supabase/supabase-js': { createClient: (_url, _key, config) => { options = config; return { auth }; } },
 });
 return { reload, secrets, stored, auth, options: () => options, state: value => onState(value), counts: () => ({ starts, stops }), event: value => event(value) };
}
const organizer = async () => Response.json({ user_id: 'verified-user', role: 'organizer' });
test('native credentials survive restart, but the role is reverified and logout clears them', async () => {
 const original = globalThis.fetch; globalThis.fetch = organizer;
 const app = setup();
 try {
  let session = app.reload(); await session.signIn('person@example.test', 'password');
  assert.equal(session.getSession().role, 'admin'); assert.equal(app.secrets.size, 1);
  session = app.reload(); assert.equal(session.getSession(), null);
  globalThis.fetch = async (_url, init) => { assert.equal(init.headers.Authorization, 'Bearer access'); return new Response(null, { status: 403 }); };
  await session.restoreSession(); assert.equal(session.getSession().role, 'user');
  await session.signOut(); assert.equal(app.secrets.size, 0);
  session = app.reload(); await session.restoreSession(); assert.equal(session.getSession(), null);
 } finally { globalThis.fetch = original; }
});
test('failed restore grants no role, and a late verification cannot undo logout', async () => {
 const original = globalThis.fetch; globalThis.fetch = organizer;
 const app = setup();
 try {
  let session = app.reload(); await session.signIn('person@example.test', 'password');
  session = app.reload(); globalThis.fetch = async () => { throw Error('offline'); };
  await session.restoreSession(); assert.equal(session.getSession(), null); assert.equal(app.secrets.size, 1);
  const started = deferred(), pending = deferred();
  globalThis.fetch = () => { started.resolve(); return pending.promise; };
  const restore = session.restoreSession(); await started.promise; await session.signOut();
  pending.resolve(await organizer()); await restore;
  assert.equal(session.getSession(), null); assert.equal(app.secrets.size, 0);
 } finally { globalThis.fetch = original; }
});
test('foreground lifecycle controls refresh and refreshed tokens reverify the account', async () => {
 const original = globalThis.fetch; globalThis.fetch = organizer;
 const app = setup(); let stop;
 try {
  const session = app.reload(); await session.signIn('person@example.test', 'password');
  stop = session.startSessionLifecycle(); app.state('background'); app.state('active');
  assert.deepEqual(app.counts(), { starts: 2, stops: 1 });
  await session.restoreSession();
  app.secrets.set('session', JSON.stringify({ ...app.stored, access_token: 'renewed' }));
  const checked = deferred();
  globalThis.fetch = async (_url, init) => { assert.equal(init.headers.Authorization, 'Bearer renewed'); checked.resolve(); return new Response(null, { status: 403 }); };
  app.event('TOKEN_REFRESHED'); await checked.promise; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(session.getSession().role, 'user');
 } finally { stop?.(); globalThis.fetch = original; }
});
test('web builds never persist auth in native storage', async () => {
 const original = globalThis.fetch; globalThis.fetch = organizer;
 try {
  const app = setup('web'); const session = app.reload(); await session.signIn('person@example.test', 'password');
  assert.equal(app.options().auth.persistSession, false); assert.equal(app.secrets.size, 0);
 } finally { globalThis.fetch = original; }
});
