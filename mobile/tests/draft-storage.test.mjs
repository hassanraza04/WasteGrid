import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../src/services/report-client.ts';
import { deferred, load } from './helpers/render.mjs';

function setup() {
 const files = new Map([['file:///camera/photo.jpg', 'image bytes']]);
 const faults = {};
 const secrets = new Map(); let session = { userId: 'owner-a' }, nextId = 0;
 const uri = parts => parts.map(part => typeof part === 'string' ? part : part.uri).join('/');
 class File extends Blob {
  constructor(...parts) { const path = uri(parts); super([files.get(path) ?? '']); this.uri = path; }
  get extension() { return '.' + this.uri.split('.').at(-1); }
  get exists() { return files.has(this.uri); }
  copy(destination) { files.set(destination.uri, files.get(this.uri)); }
  write(value) { if (faults.write) return faults.write(this, value); files.set(this.uri, value); }
  async move(destination) {
   if (faults.move) return faults.move(this, destination);
   assert.equal(files.has(destination.uri), false, 'Committed metadata must never be overwritten');
   files.set(destination.uri, files.get(this.uri)); files.delete(this.uri); this.uri = destination.uri;
  }
  async text() { if (!this.exists) throw Error('Missing file'); return files.get(this.uri); }
  delete() { if (faults.delete) return faults.delete(this); files.delete(this.uri); }
 }
 class Directory {
  constructor(...parts) { this.uri = uri(parts); }
  create() {}
  list() { return [...files.keys()].filter(key => key.startsWith(this.uri + '/')).map(key => new File(key)); }
 }
 let response = () => new Response(null, { status: 404 });
 process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.example';
 const reload = () => load('services/reports.ts', {
  '@/utils/secure-random': { randomUUID: () => 'draft-' + (++nextId), getRandomBytesAsync: async () => new Uint8Array(32) },
  'expo-secure-store': { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'device', setItemAsync: async (key, value) => { secrets.set(key, value); }, getItemAsync: async key => secrets.get(key), deleteItemAsync: async key => { secrets.delete(key); } },
  'expo-file-system': { Directory, File, Paths: { document: 'file:///documents' } },
  'expo/fetch': { fetch: (...args) => response(...args) }, 'react-native': { Platform: { OS: 'android' } },
  './report-client': client, '@/auth/session': { getSession: () => session },
 });
 return { service: reload(), reload, faults, files, secrets, signIn: value => { session = value ? { userId: value } : null; }, respond: value => { response = value; } };
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
 await assert.rejects(service.reportUpdates(anonymous), /account that saved/);
 await assert.rejects(service.reportPhoto(anonymous, 'private-photo'), /account that saved/);
  await assert.rejects(service.followupLink(anonymous), /account that saved/);
  await assert.rejects(service.messagingLinks(anonymous), /account that saved/);
  await assert.rejects(service.reportMessages(anonymous), /account that saved/);
  await assert.rejects(service.unlinkReportMessaging(anonymous, 'link-a'), /account that saved/);
});


test('one corrupt legacy draft or invalid metadata does not hide intact reports for either account', async () => {
 const { service, files, signIn } = setup();
 const a = await service.createDraft('file:///camera/photo.jpg', { title: 'A' });
 signIn('owner-b'); const b = await service.createDraft('file:///camera/photo.jpg', { title: 'B' });
 files.set('file:///documents/wastegrid-reports/broken.json', '{"id":');
 files.set('file:///documents/wastegrid-reports/invalid.json', 'null');
 files.set('file:///documents/wastegrid-reports/incomplete.json', JSON.stringify({ id: 'incomplete' }));
 files.set('file:///documents/wastegrid-reports/unfinished.1.tmp', '{"id":');
 assert.deepEqual((await service.listDrafts()).map(d => d.id), [b.id]);
 assert.equal(await service.countUnclaimedDrafts(), 0);
 await service.claimDeviceDrafts();
 signIn('owner-a'); assert.deepEqual((await service.listDrafts()).map(d => d.id), [a.id]);
 assert.equal(files.get('file:///documents/wastegrid-reports/broken.json'), '{"id":');
});

test('interrupted metadata write preserves the previous draft and can recover an accepted upload after restart', async () => {
 const { service, files, faults, reload, secrets, respond } = setup();
 const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Keep this report' });
 // Exercise migration from the original unversioned format as well.
 const committed = [...files.keys()].find(key => key.endsWith('.json'));
 const legacy = `file:///documents/wastegrid-reports/${draft.id}.json`;
 files.set(legacy, files.get(committed)); files.delete(committed);
 const previous = files.get(legacy), credential = [...secrets.values()][0];
 faults.write = (file, value) => { files.set(file.uri, value.slice(0, 20)); throw Error('Write interrupted'); };
 respond(() => Response.json({ id: draft.id, public_reference: 'WG-SAVED' }));
 await assert.rejects(service.refreshReport(draft), /Write interrupted/);
 assert.equal(files.get(legacy), previous);
 const restored = reload(); assert.deepEqual(await restored.listDrafts(), [draft]);
 assert.equal(files.has(draft.photoUri), true); assert.equal([...secrets.values()][0], credential);
 delete faults.write;
 await restored.refreshReport(draft);
 assert.equal((await restored.listDrafts())[0].reference, 'WG-SAVED');
 assert.equal(files.has(legacy), false);
});

test('failed metadata publication retains the committed revision', async () => {
 const { service, faults, reload, respond } = setup();
 const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Safe before rename' });
 faults.move = () => { throw Error('Rename interrupted'); };
 respond(() => Response.json({ id: draft.id, public_reference: 'WG-SAVED' }));
 await assert.rejects(service.refreshReport(draft), /Rename interrupted/);
 assert.deepEqual(await reload().listDrafts(), [draft]);
 delete faults.move;
 await service.refreshReport(draft);
 assert.equal((await reload().listDrafts())[0].reference, 'WG-SAVED');
});

test('leftover old revisions cannot expose an imported draft to another account', async () => {
 const { service, files, faults, reload, signIn } = setup();
 signIn(null); const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Imported' });
 faults.delete = () => { throw Error('Cleanup interrupted'); };
 signIn('owner-a'); await service.claimDeviceDrafts();
 assert.equal([...files.keys()].filter(key => key.endsWith('.json')).length, 2);
 let restarted = reload(); assert.equal((await restarted.listDrafts()).length, 1);
 signIn('owner-b'); assert.deepEqual(await restarted.listDrafts(), []);
 assert.equal(await restarted.countUnclaimedDrafts(), 0);
 await assert.rejects(restarted.refreshReport(draft), /account that saved/);
 // A malformed newest committed record is isolated, never replaced by an old anonymous revision.
 files.set(`file:///documents/wastegrid-reports/${draft.id}.2.json`, '{');
 restarted = reload(); assert.deepEqual(await restarted.listDrafts(), []);
 assert.equal(await restarted.countUnclaimedDrafts(), 0);
 await assert.rejects(restarted.refreshReport(draft));
});


test('an in-flight status save and account import preserve both ownership and accepted reference', async () => {
 const { service, files, faults, signIn, respond } = setup();
 signIn(null); const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Anonymous' });
 const entered = deferred(), finish = deferred();
 faults.write = (file, value) => {
  entered.resolve();
  return finish.promise.then(() => { files.set(file.uri, value); });
 };
 respond(() => Response.json({ id: draft.id, public_reference: 'WG-SAVED' }));
 const update = service.refreshReport(draft); await entered.promise;
 signIn('owner-a'); const claim = service.claimDeviceDrafts();
 finish.resolve(); await Promise.all([update, claim]);
 const [saved] = await service.listDrafts();
 assert.equal(saved.ownerId, 'owner-a'); assert.equal(saved.reference, 'WG-SAVED');
 signIn('owner-b'); assert.deepEqual(await service.listDrafts(), []);
 assert.equal(await service.countUnclaimedDrafts(), 0);
});

test('discard removes superseded metadata and unfinished files as well as the rejected draft', async () => {
 const { service, files, secrets, faults, respond } = setup();
 const draft = await service.createDraft('file:///camera/photo.jpg', { title: 'Rejected' });
 faults.delete = () => { throw Error('Cleanup interrupted'); };
 respond((_url, options) => new Response(null, { status: options?.method === 'POST' ? 413 : 404 }));
 await assert.rejects(service.sendDraft(draft), client.ReportRejectedError);
 files.set(`file:///documents/wastegrid-reports/${draft.id}.3.tmp`, '{');
 delete faults.delete;
 const [restored] = await service.listDrafts(); await service.discardDraft(restored);
 assert.deepEqual(await service.listDrafts(), []); assert.equal(secrets.size, 0);
 assert.deepEqual([...files.keys()], ['file:///camera/photo.jpg']);
});
