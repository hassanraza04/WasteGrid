import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { act, wrap, native, theme, ui, load, mount, button } from './helpers/render.mjs';
import { authSdk } from './helpers/auth-sdk.mjs';

function loginScreen(session) {
 const fields = {}; let blocked = false, backs = 0;
 const back = () => { if (!blocked) backs++; };
 const Login = load('app/login.tsx', {
  'react-native': { ...native, Image: wrap, Platform: { OS: 'android' } },
  '@/assets/images/wastegrid-logo.png': 1,
  'expo-router': {
   router: { back },
   usePreventRemove: busy => {
    React.useLayoutEffect(() => { blocked = busy; return () => { blocked = false; }; }, [busy]);
    return () => { blocked = false; };
   },
  },
  '@/auth/session': session, '@/theme': theme,
  '@/components/ui': { ...ui, ScreenHeader: wrap,
   Screen: ({ header, children }) => React.createElement('div', null, header, children),
   TextField: props => { fields[props.label] = props; return null; },
  },
 }).default;
 return { Login, fields, back, blocked: () => blocked, backs: () => backs,
  async fill(email = 'a@example.test') { await act(() => { fields.Email.onChangeText(email); fields.Password.onChangeText('password'); }); },
 };
}

test('login locks native removal and inputs, survives forced unmount/remount, and ignores the old navigation callback', async () => {
 const app = authSdk(); const session = app.reload(); const screen = loginScreen(session); let view;
 try {
  view = mount(screen.Login, {}); await view.render(); await screen.fill();
  await act(() => button(view.container, 'Log in').click()); await app.waitForRequest();
  assert.equal(screen.blocked(), true); screen.back(); assert.equal(screen.backs(), 0);
  assert.equal(view.container.querySelector('[aria-label="Close"]').disabled, true);
  assert.equal(screen.fields.Email.editable, false); assert.equal(screen.fields.Password.editable, false);
  await view.close(); view = mount(screen.Login, {}); await view.render();
  assert.equal(screen.blocked(), true); assert.equal(button(view.container, 'Log in').disabled, true);
  await screen.fill('b@example.test');
  await act(() => button(view.container, 'Log in').click());
  assert.equal(app.requests.length, 1);
  await act(async () => { app.requests[0].resolve(app.response('a@example.test')); await session.restoreSession(); });
  assert.equal(screen.backs(), 0); assert.equal(screen.blocked(), false);
  assert.equal(session.getSession().userId, 'a');
  await act(() => button(view.container, 'Log in').click());
  await app.waitForRequest(2);
  await act(async () => { app.requests[1].resolve(app.response('b@example.test')); await session.restoreSession(); });
  assert.equal(screen.blocked(), false); assert.equal(screen.backs(), 1); assert.equal(session.getSession().userId, 'b');
  assert.match(view.container.textContent, /securely saved on this device/);
 } finally {
  await act(async () => { app.requests.forEach(request => request.resolve(app.response(request.email))); await session.restoreSession(); });
  await view?.close(); await app.close();
 }
});

test('a failed login stays on screen, releases native removal, and permits retry', async () => {
 const app = authSdk(); const session = app.reload(); const screen = loginScreen(session); const view = mount(screen.Login, {});
 try {
  await view.render(); await screen.fill();
  await act(() => button(view.container, 'Log in').click()); await app.waitForRequest();
  await act(async () => {
   app.requests[0].resolve(Response.json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, { status: 400 }));
   // Restoration is intentionally suspended during failed-sign-in cleanup.
   for (let i = 0; i < 100 && session.isAuthBusy(); i++) await new Promise(resolve => setImmediate(resolve));
  });
  assert.equal(screen.backs(), 0); assert.equal(screen.blocked(), false);
  assert.equal(button(view.container, 'Log in').disabled, false); assert.match(view.container.textContent, /Sign-in failed/);
  assert.equal(session.getSession(), null); assert.equal(app.secrets.size, 0);
 } finally { await view.close(); await app.close(); }
});
