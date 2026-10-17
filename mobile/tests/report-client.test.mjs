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

const { reportFields, ReportRejectedError, sendSavedDraft, discardRejectedDraft } = await import('../src/services/report-client.ts');
test('address-only submissions omit coordinates and unanswered safety questions', async () => {
 const fields = reportFields(' Bags outside ', { coords: null, address: ' 12 Main Street ' });
 const { request, calls } = transport(new Response(null, { status: 404 }), Response.json({ report }));
 await uploadReport({ ...draft, fields }, 'token', photo, request);
 const body = calls[1][1].body;
 assert.equal(body.get('address'), '12 Main Street');
 for (const key of ['latitude', 'longitude', 'resident_fire', 'resident_sharp_objects']) assert.equal(body.has(key), false);
});
test('form validation accepts GPS without an address and rejects missing or oversized addresses', () => {
 assert.equal(reportFields('Bags', { coords: { latitude: 0, longitude: 0 }, address: '' }).latitude, '0');
 assert.throws(() => reportFields('Bags', { coords: null, address: ' ' }), /address/);
 assert.throws(() => reportFields('Bags', { coords: null, address: 'x'.repeat(501) }), /500/);
 assert.throws(() => reportFields(' ', { coords: null, address: 'Street' }), /caption/);
});
for (const status of [413, 415, 422]) {
 test(`persists rejection after POST ${status} so it survives app restart`, async () => {
  const { request } = transport(new Response(null, { status: 404 }), new Response(null, { status }));
  let saved;
  await assert.rejects(sendSavedDraft(draft, 'token', photo, request, async value => { saved = value; }), ReportRejectedError);
  assert.ok(saved.rejection);
  assert.deepEqual(saved.fields, draft.fields);
  assert.equal(saved.id, draft.id);
 });
 test(`a GET ${status} is not evidence that an upload was rejected`, async () => {
  const { request } = transport(new Response(null, { status }));
  let saved = false;
  await assert.rejects(sendSavedDraft(draft, 'token', photo, request, async () => { saved = true; }));
  assert.equal(saved, false);
 });
}
test('ambiguous upload failures retain the immutable identity without allowing discard', async () => {
 for (const failure of [new Error('lost response'), new Response(null, { status: 500 }), new Response(null, { status: 409 })]) {
  const { request } = transport(new Response(null, { status: 404 }), failure);
  let saved = false;
  await assert.rejects(sendSavedDraft(draft, 'token', photo, request, async () => { saved = true; }));
  assert.equal(saved, false);
 }
});
test('discard removes only a rejected draft with a successful server absence check', async () => {
 let removed = 0;
 const rejected = { ...draft, rejection: 'Rejected' };
 for (const guarded of [draft, { ...rejected, reference: 'WG-REAL' }]) {
  await assert.rejects(discardRejectedDraft(guarded, 'token', async () => { throw Error('should not request'); }, async () => { removed++; }));
 }
 for (const response of [Response.json(report), new Error('offline'), new Response(null, { status: 503 })]) {
  const { request } = transport(response);
  await assert.rejects(discardRejectedDraft(rejected, 'token', request, async () => { removed++; }));
 }
 assert.equal(removed, 0);
 const { request } = transport(new Response(null, { status: 404 }));
 await discardRejectedDraft(rejected, 'token', request, async () => { removed++; });
 assert.equal(removed, 1);
});
test('recovering an accepted report clears an older rejection without deleting credentials', async () => {
 const { request } = transport(Response.json(report));
 let saved;
 await sendSavedDraft({ ...draft, rejection: 'Old rejection', ownerId: 'owner' }, 'token', photo, request, async value => { saved = value; });
 assert.equal(saved.reference, report.public_reference);
 assert.equal(saved.ownerId, 'owner');
 assert.equal(saved.rejection, undefined);
});
