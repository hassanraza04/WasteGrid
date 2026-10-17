import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './helpers/render.mjs';
import { authSdk, tick } from './helpers/auth-sdk.mjs';

test('overlapping sign-ins cannot write competing SDK sessions, including after restart', async () => {
 const app = authSdk(); let first, second;
 try {
  const session = app.reload();
  first = session.signIn('a@example.test', 'password'); await app.waitForRequest();
  second = session.signIn('b@example.test', 'password');
  const rejected = assert.rejects(second, /in progress/);
  // Before the fix B reaches the SDK and completes ahead of A, reproducing the review.
  await tick(); if (app.requests[1]) app.requests[1].resolve(app.response('b@example.test'));
  await rejected; assert.equal(app.requests.length, 1);
  app.requests[0].resolve(app.response('a@example.test')); await first;
  assert.equal(session.getSession().userId, 'a');
  await session.restoreSession(); assert.equal(session.getSession().userId, 'a');
  const retry = session.signIn('b@example.test', 'password');
  (await app.waitForRequest(2)).resolve(app.response('b@example.test')); await retry;
  assert.equal(session.getSession().userId, 'b');
  await session.restoreSession(); assert.equal(session.getSession().userId, 'b');
  assert.equal((await app.clients[0].auth.getSession()).data.session.user.id, 'b');
  await app.clients[0].auth.dispose(); const restarted = app.reload(); await restarted.restoreSession();
  assert.equal(restarted.getSession().userId, 'b');
 } finally {
  app.requests.forEach(request => request.resolve(app.response(request.email)));
  await Promise.allSettled([first, second]); await app.close();
 }
});

test('logout invalidates login immediately, waits for its last SDK write, and leaves no restorable account', async () => {
 const app = authSdk(); const logoutReply = deferred(); let login, logout, stop;
 try {
  const session = app.reload(); stop = session.startSessionLifecycle(); await session.restoreSession();
  login = session.signIn('a@example.test', 'password'); const cancelled = assert.rejects(login, /cancelled/);
  await app.waitForRequest(); app.logout(() => logoutReply.promise);
  logout = session.signOut(); assert.equal(session.signOut(), logout);
  assert.equal(session.getSession(), null); assert.equal(session.isAuthBusy(), true);
  await assert.rejects(session.signIn('b@example.test', 'password'), /in progress/);
  app.state('background'); app.state('active'); await session.restoreSession();
  app.requests[0].resolve(app.response('a@example.test')); await cancelled;
  assert.equal(session.isAuthBusy(), true); // Login finished, logout still owns the guard.
  await assert.rejects(session.signIn('b@example.test', 'password'), /in progress/);
  logoutReply.resolve(new Response(null, { status: 204 })); await logout;
  assert.equal(session.getSession(), null); assert.equal(session.isAuthBusy(), false); assert.equal(app.secrets.size, 0);
  assert.equal((await app.clients[0].auth.getSession()).data.session, null);
  stop(); stop = undefined; await app.clients[0].auth.dispose();
  const restarted = app.reload(); await restarted.restoreSession(); assert.equal(restarted.getSession(), null);
 } finally {
  app.requests.forEach(request => request.resolve(app.response(request.email)));
  logoutReply.resolve(new Response(null, { status: 204 }));
  await Promise.allSettled([login, logout]); stop?.(); await app.close();
 }
});

test('restoration owns the guard and logout discards a late backend identity', async () => {
 const app = authSdk(); const verification = deferred(); const started = deferred(); let restore, logout;
 try {
  let session = app.reload(); const login = session.signIn('a@example.test', 'password');
  (await app.waitForRequest()).resolve(app.response('a@example.test')); await login;
  await app.clients[0].auth.dispose(); session = app.reload();
  app.backend(() => { started.resolve(); return verification.promise; });
  restore = session.restoreSession(); await started.promise; assert.equal(session.isAuthBusy(), true);
  await assert.rejects(session.signIn('b@example.test', 'password'), /in progress/);
  logout = session.signOut(); assert.equal(session.getSession(), null);
  verification.resolve(Response.json({ user_id: 'a', role: 'organizer' })); await Promise.all([restore, logout]);
  assert.equal(app.requests.length, 1); assert.equal(session.getSession(), null); assert.equal(app.secrets.size, 0);
 } finally {
  verification.resolve(new Response(null, { status: 403 }));
  await Promise.allSettled([restore, logout]); await app.close();
 }
});

test('failed credentials and failed role verification clear the SDK session and allow an explicit retry', async () => {
 const app = authSdk();
 try {
  const session = app.reload();
  for (const failAt of ['password', 'identity']) {
   app.backend(async () => new Response(null, { status: 503 }));
   const failed = session.signIn('a@example.test', 'incorrect');
   const rejected = assert.rejects(failed, /Sign-in failed|Unable to verify/);
   const request = await app.waitForRequest(app.requests.length + 1);
   request.resolve(failAt === 'password' ? Response.json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, { status: 400 }) : app.response('a@example.test'));
   await rejected; assert.equal(session.isAuthBusy(), false); assert.equal(session.getSession(), null);
   assert.equal((await app.clients[0].auth.getSession()).data.session, null); assert.equal(app.secrets.size, 0);
  }
  app.backend(async () => new Response(null, { status: 403 }));
  const retry = session.signIn('b@example.test', 'password');
  (await app.waitForRequest(3)).resolve(app.response('b@example.test')); await retry;
  assert.equal(session.getSession().userId, 'b');
 } finally { await app.close(); }
});

test('a timed-out SDK request is aborted before another login can run', async t => {
 const app = authSdk(); let login; t.mock.timers.enable({ apis: ['setTimeout'] });
 try {
  const session = app.reload(); login = session.signIn('a@example.test', 'password');
  const rejected = assert.rejects(login, /timed out/); const request = await app.waitForRequest();
  await assert.rejects(session.signIn('b@example.test', 'password'), /in progress/);
  t.mock.timers.tick(60_000); await rejected;
  assert.equal(request.signal.aborted, true); assert.equal(session.isAuthBusy(), false);
  request.resolve(app.response('a@example.test')); await tick();
  assert.equal(session.getSession(), null); assert.equal(app.secrets.size, 0);
  const retry = session.signIn('b@example.test', 'password');
  (await app.waitForRequest(2)).resolve(app.response('b@example.test')); await retry;
  assert.equal((await app.clients[0].auth.getSession()).data.session.user.id, 'b');
 } finally {
  t.mock.timers.reset(); app.requests.forEach(request => request.resolve(app.response(request.email)));
  await Promise.allSettled([login]); await app.close();
 }
});

test('foreground and token-refresh events during login cannot restore the previous account', async () => {
 const app = authSdk(); let stop, login; const verified = [];
 try {
  app.backend(async (_url, init) => { verified.push(init.headers.Authorization); return new Response(null, { status: 403 }); });
  const session = app.reload(); const first = session.signIn('a@example.test', 'password');
  (await app.waitForRequest()).resolve(app.response('a@example.test')); await first;
  stop = session.startSessionLifecycle(); await session.restoreSession(); await tick();
  login = session.signIn('b@example.test', 'password'); await app.waitForRequest(2); const before = verified.length;
  app.state('background'); app.state('active');
  // Deliver a real TOKEN_REFRESHED event through the installed SDK's public API.
  const refresh = app.clients[0].auth.refreshSession();
  for (let i = 0; i < 100 && !app.refreshes.length; i++) await tick(); assert.equal(app.refreshes.length, 1);
  app.refreshes[0].resolve(app.response('a@example.test')); await refresh;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(verified.length, before); assert.equal(session.getSession(), null); assert.equal(session.isAuthBusy(), true);
  app.requests[1].resolve(app.response('b@example.test')); await login;
  await session.restoreSession(); assert.equal(session.getSession().userId, 'b');
  assert.equal((await app.clients[0].auth.getSession()).data.session.user.id, 'b');
 } finally {
  app.requests.forEach(request => request.resolve(app.response(request.email)));
  app.refreshes.forEach(request => request.resolve(app.response('a@example.test')));
  await Promise.allSettled([login]); stop?.(); await app.close();
 }
});

test('a failed logout request still removes local SDK credentials and cannot be restored', async () => {
 const app = authSdk();
 try {
  const session = app.reload(); const login = session.signIn('a@example.test', 'password');
  (await app.waitForRequest()).resolve(app.response('a@example.test')); await login;
  app.logout(async () => Response.json({ message: 'unavailable' }, { status: 503 }));
  await assert.rejects(session.signOut(), /Unable to finish signing out/);
  await session.restoreSession(); assert.equal(session.getSession(), null); assert.equal(app.secrets.size, 0);
  assert.equal((await app.clients[0].auth.getSession()).data.session, null);
  await app.clients[0].auth.dispose(); const restarted = app.reload();
  await restarted.restoreSession(); assert.equal(restarted.getSession(), null);
 } finally { await app.close(); }
});
