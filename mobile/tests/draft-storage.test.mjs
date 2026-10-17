import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../src/services/report-client.ts';
import { load } from './helpers/render.mjs';

function setup() {
 const files = new Map([['file:///camera/photo.jpg', 'image bytes']]);
 const secrets = new Map(); let session = { userId: 'owner-a' }, nextId = 0;
 const uri = parts => parts.map(part => typeof part === 'string' ? part : part.uri).join('/');
 class File extends Blob {
  constructor(...parts) { const path = uri(parts); super([files.get(path) ?? '']); this.uri = path; }
  get extension() { return '.' + this.uri.split('.').at(-1); }
  get exists() { return files.has(this.uri); }
  copy(destination) { files.set(destination.uri, files.get(this.uri)); }
  write(value) { files.set(this.uri, value); }
  async text() { if (!this.exists) throw Error('Missing file'); return files.get(this.uri); }
  delete() { files.delete(this.uri); }
 }
 class Directory {
  constructor(...parts) { this.uri = uri(parts); }
  create() {}
  list() { return [...files.keys()].filter(key => key.startsWith(this.uri + '/')).map(key => new File(key)); }
 }
 let response = () => new Response(null, { status: 404 });
 process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example';
 const service = load('services/reports.ts', {
  'expo-crypto': { randomUUID: () => 'draft-' + (++nextId), getRandomBytesAsync: async () => new Uint8Array(32) },
  'expo-secure-store': { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device', setItemAsync: async (key, value) => { secrets.set(key, value); }, getItemAsync: async key => secrets.get(key), deleteItemAsync: async key => { secrets.delete(key); } },
  'expo-file-system': { Directory, File, Paths: { document: 'file:///documents' } },
  'expo/fetch': { fetch: (...args) => response(...args) }, 'react-native': { Platform: { OS: 'android' } },
  './report-client': client, '@/auth/session': { getSession: () => session },
 });
 return { service, files, secrets, signIn: value => { session = value ? { userId: value } : null; }, respond: value => { response = value; } };
}
test('saved reports are isolated by account and legacy drafts require explicit import', async () => {
 const { service, signIn } = setup();
 const first = await service.createDraft('file:///camera/photo.jpg', { title: 'A' });
 signIn('owner-b'); assert.deepEqual(await service.listDrafts(), []);
 await assert.rejects(service.refreshReport(first), /account that saved/);
 signIn(null); await service.createDraft('file:///camera/photo.jpg', { title: 'Anonymous' });
 assert.deepEqual(await service.listDrafts(), []);
 signIn('owner-b'); assert.equal(await service.countUnclaimedDrafts(), 1);
 assert.deepEqual(await service.listDrafts(), []);
 await service.claimDeviceDrafts();
 assert.deepEqual((await service.listDrafts()).map(draft => draft.fields.title), ['Anonymous']);
 signIn('owner-a'); assert.deepEqual((await service.listDrafts()).map(draft => draft.id), [first.id]);
});
test('rejected upload can be discarded after restart, including photo, metadata and token', async () => {
 const { service, files, secrets, respond } = setup();
 const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Rejected' });
 respond((_url, options) => new Response(null, { status: options?.method === 'POST' ? 413 : 404 }));
 await assert.rejects(service.sendDraft(draft), client.ReportRejectedError);
 const [restored] = await service.listDrafts(); assert.ok(restored.rejection);
 await service.discardDraft(restored);
 assert.deepEqual(await service.listDrafts(), []);
 assert.equal(files.has(draft.photoUri), false); assert.equal(secrets.size, 0);
 assert.equal(files.has('file:///camera/photo.jpg'), true);
});
test('status refresh recovers accepted uploads and clears obsolete rejection state', async () => {
 const { service, respond } = setup();
 const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Recovered' });
 respond((_url, options) => new Response(null, { status: options?.method === 'POST' ? 422 : 404 }));
 await assert.rejects(service.sendDraft(draft), client.ReportRejectedError);
 const [restored] = await service.listDrafts();
 respond(() => Response.json({ id: draft.id, public_reference: 'WG-ACCEPTED' }));
 await service.refreshReport(restored);
 const [saved] = await service.listDrafts(); assert.equal(saved.reference, 'WG-ACCEPTED'); assert.equal(saved.rejection, undefined);
 await assert.rejects(service.discardDraft(restored), /Only a rejected/);
});

test('a stale anonymous draft object cannot bypass ownership after import', async () => {
 const { service, signIn } = setup();
 signIn(null);
 const anonymous = await service.createDraft('file:///camera/photo.jpg', { title: 'Anonymous' });
 signIn('owner-a'); await service.claimDeviceDrafts();
 signIn('owner-b');
 await assert.rejects(service.refreshReport(anonymous), /account that saved/);
 await assert.rejects(service.sendDraft(anonymous), /account that saved/);
});
