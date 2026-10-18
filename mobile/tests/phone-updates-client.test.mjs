import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDefinitePhoneRejection, PhoneUpdatesError, readPhoneUpdates, requestPhoneUpdate, statusCommand } from '../src/services/phone-updates-client.ts';
const draft = { id: 'report-a', apiUrl: 'https://api.example' };
const id = '00000000-0000-4000-8000-000000000001';
const receipt = { id, status: 'queued', message: 'Cleanup is in progress.', created_at: '2026-10-18T00:00:00Z' };

test('phone updates use resident authorization and only the fixed Status command with explicit consent', async () => {
 const calls = [];
 const request = async (url, options) => {
  calls.push([url, options]);
  return Response.json(options.method === 'GET' ? { enabled: true, phone_label: 'Phone ending 1234', latest_request: receipt } : receipt);
 };
 assert.equal((await readPhoneUpdates(draft, 'private-token', request)).latest_request.status, 'queued');
 assert.deepEqual(await requestPhoneUpdate(draft, 'private-token', id, '  sTaTuS \n', request), receipt);
 assert.deepEqual(calls.map(([url]) => url), ['https://api.example/reports/report-a/phone-updates', 'https://api.example/reports/report-a/phone-updates']);
 assert.ok(calls.every(([, options]) => options.headers.Authorization === 'Bearer private-token' && options.redirect === 'error'));
 assert.deepEqual(JSON.parse(calls[1][1].body), { command_id: id, message: 'Status', consent: true });
 assert.doesNotMatch(calls[1][1].body, /phone|recipient|private-token/);
});
test('unsupported input fails locally and never invokes an AI or transport', async () => {
 for (const text of ['', 'help', 'Status please', 'Send to +15555555555']) {
  assert.throws(() => statusCommand(text), /Type "Status"/);
  await assert.rejects(requestPhoneUpdate(draft, 'token', id, text, async () => { throw Error('must not request'); }), /Type "Status"/);
 }
});
test('provider acceptance and all terminal states remain distinct in parsed receipts', async () => {
 for (const status of ['queued', 'sending', 'submitted', 'delivered', 'failed', 'uncertain', 'cancelled']) {
  const result = await requestPhoneUpdate(draft, 'token', id, 'Status', async () => Response.json({ ...receipt, status }));
  assert.equal(result.status, status);
 }
});
test('malformed or mismatched responses cannot acknowledge a saved request', async () => {
 for (const response of [{ ...receipt, id: 'different' }, { ...receipt, status: 'sent' }, { ...receipt, created_at: 'bad' }, { ...receipt, message: null }]) {
  await assert.rejects(requestPhoneUpdate(draft, 'token', id, 'Status', async () => Response.json(response)), PhoneUpdatesError);
 }
 await assert.rejects(readPhoneUpdates(draft, 'token', async () => Response.json({ enabled: true, phone_label: null, latest_request: null })), /Unable to check/);
});
test('HTTP and transport errors expose only safe guidance and preserve uncertain outcomes', async () => {
 for (const status of [401, 404, 409, 422, 429, 503]) {
  await assert.rejects(requestPhoneUpdate(draft, 'token', id, 'Status', async () => new Response('provider secret', { status })), error => error.status === status && !error.message.includes('provider secret'));
 }
 await assert.rejects(requestPhoneUpdate(draft, 'token', id, 'Status', async () => { throw Error('token in transport diagnostics'); }), error => error.status === undefined && /same request/.test(error.message) && !error.message.includes('diagnostics'));
});


test('HTTP 408 and unknown errors retain request identity; only known rejection statuses are definitive', () => {
 for (const status of [undefined, 408, 500, 503]) assert.equal(isDefinitePhoneRejection(new PhoneUpdatesError('Unconfirmed', status)), false);
 for (const status of [401, 403, 404, 409, 422, 429]) assert.equal(isDefinitePhoneRejection(new PhoneUpdatesError('Rejected', status)), true);
});
