import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport, residentToken, uploadReport } from '../src/services/report-client.ts';
const draft = { id: 'd1e2f3a4-1111-4111-8111-111111111111', apiUrl: 'https://api.example', photoUri: 'file:///saved/photo.jpg', mime: 'image/jpeg', fields: { title: 'Mobile report', latitude: '24.9', longitude: '67.1', resident_fire: 'false', resident_sharp_objects: 'true' } };
const report = { id: draft.id, public_reference: 'WG-REAL', title: 'Mobile report', display_status: 'received', assessment_status: 'pending' };
const photo = new Blob(['photo-bytes'], { type: 'image/jpeg' });
function transport(...responses) {
 const calls = [];
 const request = async (...args) => { calls.push(args); const result = responses.shift(); if (result instanceof Error) throw result; return result; };
 return { request, calls };
}
test('uploads multipart bytes, stable identity, coordinates and resident answers', async () => {
 const { request, calls } = transport(new Response(null, { status: 404 }), Response.json({ report }));
 assert.deepEqual(await uploadReport(draft, 'resident-token', photo, request), report);
 const [url, init] = calls[1]; assert.equal(url, 'https://api.example/reports');
 assert.deepEqual(init.headers, { 'X-Report-Token': 'resident-token' });
 assert.equal(init.body.get('client_report_id'), draft.id);
 assert.equal(await init.body.get('photo').text(), 'photo-bytes');
 assert.equal(init.body.get('photo').type, 'image/jpeg');
 assert.equal(init.body.get('resident_sharp_objects'), 'true');
 assert.equal(init.body.get('latitude'), '24.9');
});
test('recovers an accepted upload whose response was lost without posting twice', async () => {
 const { request, calls } = transport(new Response(null, { status: 404 }), new Error('lost response'), Response.json(report));
 await assert.rejects(uploadReport(draft, 'resident-token', photo, request), /lost response/);
 assert.deepEqual(await uploadReport(draft, 'resident-token', photo, request), report);
 assert.equal(calls.filter(([, init]) => init?.method === 'POST').length, 1);
 assert.deepEqual(calls[2][1].headers, { Authorization: 'Bearer resident-token' });
});
test('does not upload if the recovery check cannot establish server state', async () => {
 const { request, calls } = transport(new Error('offline'));
 await assert.rejects(uploadReport(draft, 'resident-token', photo, request), /offline/); assert.equal(calls.length, 1);
});
for (const status of [401, 403, 409, 413, 415, 422, 500]) {
 test(`preserves failed draft on HTTP ${status} without exposing response data`, async () => {
  const { request } = transport(new Response(null, { status: 404 }), new Response('server-secret', { status }));
  await assert.rejects(uploadReport(draft, 'resident-token', photo, request), error => error.status === status && !error.message.includes('server-secret'));
  assert.equal(draft.reference, undefined);
 });
}
test('rejects unauthorized tracking and mismatched response identities', async () => {
 const { request } = transport(new Response(null, { status: 401 }), Response.json({ ...report, id: 'other' }), new Response(null, { status: 404 }), Response.json({ report: { ...report, id: 'other' } }));
 await assert.rejects(readReport(draft, 'wrong', request), /cannot access/);
 await assert.rejects(readReport(draft, 'token', request), /Unexpected/);
 await assert.rejects(uploadReport(draft, 'token', photo, request), /Unexpected/);
});
test('encodes all 32 random bytes into the backend token format', () => {
 const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
 assert.equal(residentToken(bytes), 'wg_r_' + Buffer.from(bytes).toString('base64url'));
 assert.match(residentToken(bytes), /^wg_r_[A-Za-z0-9_-]{43}$/);
});
