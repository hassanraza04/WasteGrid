import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from '../src/auth/session-client.ts';
const user = { userId: 'verified-user', email: 'resident@example.test', token: 'session-token' };
function auth() {
 return { signedOut: 0, async signIn() { return user; }, async signOut() { this.signedOut++; } };
}
test('a Supabase user without a staff membership is a resident', async () => {
 const gateway = auth();
 const result = await authenticate(user.email, 'password', gateway, async (url, init) => {
  assert.equal(url, 'https://api.example/auth/me');
  assert.equal(init.headers.Authorization, 'Bearer session-token');
  return new Response(null, { status: 403 });
 }, 'https://api.example');
 assert.deepEqual(result, { userId: user.userId, email: user.email, role: 'user' });
});
test('role and crew identity come from the verified backend response', async () => {
 for (const [backend, role] of [['organizer', 'admin'], ['crew', 'crew']]) {
  const session = await authenticate(user.email, 'password', auth(), async () => Response.json({ user_id: user.userId, role: backend, crew_id: 'crew-uuid' }), 'https://api.example');
  assert.equal(session.role, role); assert.equal(session.crewId, 'crew-uuid');
 }
});
test('failed verification clears authentication rather than granting a fallback role', async () => {
 for (const reply of [new Response(null, { status: 401 }), new Response(null, { status: 503 }), Response.json({ user_id: 'different-user', role: 'organizer' }), Response.json({ user_id: user.userId, role: 'crew', crew_id: null })]) {
  const gateway = auth();
  await assert.rejects(authenticate(user.email, 'password', gateway, async () => reply, 'https://api.example'));
  assert.equal(gateway.signedOut, 1);
 }
});
test('network failure does not silently downgrade a staff account', async () => {
 const gateway = auth();
 await assert.rejects(authenticate(user.email, 'password', gateway, async () => { throw new Error('offline'); }, 'https://api.example'));
 assert.equal(gateway.signedOut, 1);
});
