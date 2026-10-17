import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFollowupLink, readMessagingLinks, unlinkMessaging, readReportMessages } from '../src/services/report-client.ts';
const draft = { id: 'report-a', apiUrl: 'https://api.example' };
const links = { enabled: true, recipient: 'pilot@example.test', links: [{ id: 'link-a', channel: 'imessage', active: true, paused: false }] };

test('report messaging uses the private report credential and fixed report-scoped endpoints', async () => {
 const calls = [];
 const responses = [Response.json({ link_code: 'secret_code', expires_at: new Date(Date.now() + 600000).toISOString(), recipient: 'pilot@example.test', channel: 'imessage' }), Response.json(links), new Response(null, { status: 204 }), Response.json({ items: [{ id: 'm1', body: 'Report A only', direction: 'inbound', created_at: '2026-10-17T00:00:00Z' }], limit: 50, offset: 50, total: 51 })];
 const request = async (url, init) => { calls.push([url, init]); return responses.shift(); };
 const code = await createFollowupLink(draft, 'private-report-token', request);
 assert.equal(code.link_code, 'secret_code');
 assert.deepEqual(await readMessagingLinks(draft, 'private-report-token', request), links);
 await unlinkMessaging(draft, 'private-report-token', 'link/a', request);
 assert.equal((await readReportMessages(draft, 'private-report-token', 50, request)).items[0].body, 'Report A only');
 assert.deepEqual(calls.map(([url]) => url), ['followup-link', 'messaging-links', 'messaging-links/link%2Fa/unlink', 'messages?limit=50&offset=50'].map(path => `https://api.example/reports/report-a/${path}`));
 assert.ok(calls.every(([, init]) => init.headers.Authorization === 'Bearer private-report-token' && init.redirect === 'error'));
 assert.equal(calls[0][1].body, '{}');
 assert.ok(!calls.some(([url]) => url.includes('private-report-token')));
});
test('expired or malformed codes, broken pagination and unauthorized requests fail without provider data', async () => {
 for (const value of [
  { link_code: 'secret', expires_at: '2001-01-01', recipient: 'pilot@example.test', channel: 'imessage' },
  { link_code: 'secret', expires_at: new Date(Date.now() + 600000).toISOString(), recipient: '', channel: 'imessage' },
 ]) await assert.rejects(createFollowupLink(draft, 'token', async () => Response.json(value)), /not ready/);
 await assert.rejects(readReportMessages(draft, 'token', 0, async () => Response.json({ items: [], offset: 1, limit: 50, total: 0 })), /conversation/);
 await assert.rejects(readMessagingLinks(draft, 'token', async () => new Response('provider secret', { status: 403 })), error => !error.message.includes('provider secret'));
 await assert.rejects(readReportMessages(draft, 'token', -1, async () => { throw Error('must not request'); }), /Invalid conversation/);
});
