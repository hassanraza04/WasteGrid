// Real Supabase session persistence; only HTTP and native protected storage are substituted.
import { createClient } from '@supabase/supabase-js';
import { deferred, load } from './render.mjs';
import * as sessionClient from '../../src/auth/session-client.ts';

export const tick = () => new Promise(resolve => setImmediate(resolve));
export function authSdk() {
 const secrets = new Map(), clients = [], requests = [], refreshes = [];
 const originalFetch = globalThis.fetch;
 let onState, backend = async () => new Response(null, { status: 403 }), logout = async () => new Response(null, { status: 204 });
 function response(email) {
  const id = email.split('@')[0], exp = Math.floor(Date.now() / 1000) + 3600;
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from(JSON.stringify({ sub: id, exp })).toString('base64url'), 'signature'].join('.');
  return Response.json({ access_token: token, refresh_token: 'refresh-' + id, expires_in: 3600, expires_at: exp, token_type: 'bearer', user: { id, email, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
 }
 const fetcher = async (url, init) => {
  if (String(url).endsWith('/auth/me')) return backend(url, init);
  if (String(url).includes('/logout')) return logout(url, init);
  if (String(url).includes('/token?grant_type=refresh_token')) {
   const pending = deferred(); refreshes.push(pending); return pending.promise;
  }
  if (String(url).includes('/token?grant_type=password')) {
   const pending = deferred();
   const request = { ...pending, email: JSON.parse(init.body).email, signal: init.signal };
   requests.push(request);
   init.signal?.addEventListener('abort', () => pending.reject(init.signal.reason), { once: true });
   if (init.signal?.aborted) pending.reject(init.signal.reason);
   return pending.promise;
  }
  throw new Error('Unexpected auth test endpoint: ' + url);
 };
 globalThis.fetch = fetcher;
 process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example';
 process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://auth.example';
 process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
 const reload = () => load('auth/session.ts', {
  './session-client': sessionClient,
  'react-native': { Platform: { OS: 'android' }, AppState: { currentState: 'active', addEventListener: (_type, fn) => { onState = fn; return { remove() { onState = undefined; } }; } } },
  'expo-secure-store': { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'protected',
   getItemAsync: async key => secrets.get(key) ?? null,
   setItemAsync: async (key, value) => { secrets.set(key, value); },
   deleteItemAsync: async key => { secrets.delete(key); } },
  '@supabase/supabase-js': { createClient: (url, key, options) => {
   const sdk = createClient(url, key, options); clients.push(sdk); return sdk;
  } },
 });
 return {
  reload, requests, refreshes, secrets, clients, response,
  backend: fn => { backend = fn; }, logout: fn => { logout = fn; }, state: value => onState?.(value),
  async waitForRequest(count = 1) { for (let i = 0; i < 100 && requests.length < count; i++) await tick(); if (requests.length < count) throw Error('Authentication request did not start'); return requests[count - 1]; },
  async close() { for (const client of clients) await client.auth.dispose(); globalThis.fetch = originalFetch; },
 };
}
