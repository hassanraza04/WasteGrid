import * as Crypto from "@/utils/secure-random";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { discardRejectedDraft, readReportUpdates, readPhotoAccess, readReport, residentToken, sendSavedDraft, type ReportDraft, type Transport } from "./report-client";

import { getSession } from "@/auth/session";

const request: Transport = (url, init) => fetch(url, init);
function directory() {
  if (Platform.OS === "web") throw new Error("Use the mobile app to save reports securely on this device.");
  const dir = new Directory(Paths.document, "wastegrid-reports");
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}
const tokenKey = (id: string) => `wastegrid.report.${id}`;

export async function createDraft(photoUri: string, fields: Record<string, string>): Promise<ReportDraft> {
  const ownerId = getSession()?.userId;
  const apiUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (!apiUrl || !(apiUrl.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl))) {
    throw new Error("Report submission has not been configured for this app.");
  }
  const source = new File(photoUri);
  const extension = source.extension.toLowerCase();
  const mime = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" } as Record<string, string>)[extension];
  if (!mime) throw new Error("Use a JPEG, PNG or WebP photo.");
  if (!source.exists || source.size > 8 * 1024 * 1024) throw new Error("Choose a photo smaller than 8 MiB.");
  const dir = directory();
  const id = Crypto.randomUUID();
  const destination = new File(dir, `${id}${extension}`);
  const token = residentToken(await Crypto.getRandomBytesAsync(32));
  // Persist credentials, immutable form values and durable bytes before any HTTP call.
  await SecureStore.setItemAsync(tokenKey(id), token, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  await source.copy(destination);
  const draft: ReportDraft = { id, apiUrl, photoUri: destination.uri, mime, fields, ownerId };
  await saveDraft(draft);
  return draft;
}

type Metadata = { file: File; id: string; revision: number };
function metadataFiles(): Metadata[] {
  return directory().list().flatMap(file => {
    if (!(file instanceof File)) return [];
    // Legacy <id>.json is revision zero. Incomplete .tmp files are never published.
    const match = /^([^.]+)(?:\.(\d+))?\.json$/.exec(file.uri.split("/").at(-1) ?? "");
    return match ? [{ file, id: match[1], revision: Number(match[2] ?? 0) }] : [];
  }).sort((a, b) => b.revision - a.revision);
}
async function readMetadata(record: Metadata): Promise<ReportDraft> {
  const draft = JSON.parse(await record.file.text());
  if (!draft || draft.id !== record.id || typeof draft.apiUrl !== "string" ||
      typeof draft.photoUri !== "string" || typeof draft.mime !== "string" ||
      !draft.fields || typeof draft.fields !== "object" || Array.isArray(draft.fields) ||
      !Object.values(draft.fields).every(value => typeof value === "string") ||
      ["ownerId", "reference", "rejection"].some(key => draft[key] !== undefined && typeof draft[key] !== "string")) {
    throw new Error("This saved report's metadata is unreadable. Its photo and access key have been preserved.");
  }
  return draft;
}
async function storedDraft(id: string): Promise<ReportDraft | undefined> {
  const record = metadataFiles().find(record => record.id === id);
  return record ? readMetadata(record) : undefined;
}
async function allDrafts(): Promise<ReportDraft[]> {
  const latest = new Map<string, Metadata>();
  for (const record of metadataFiles()) if (!latest.has(record.id)) latest.set(record.id, record);
  const drafts = await Promise.all([...latest.values()].map(async record => {
    try { return await readMetadata(record); }
    catch { return null; } // Isolate unreadable drafts; retain their files/tokens for recovery.
  }));
  return drafts.filter((draft): draft is ReportDraft => draft !== null);
}

// Serialize metadata changes for each report, including account import and discard.
const mutations = new Map<string, Promise<unknown>>();
function serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
  const pending = (mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
  mutations.set(id, pending);
  return pending.finally(() => { if (mutations.get(id) === pending) mutations.delete(id); });
}

export async function listDrafts(): Promise<ReportDraft[]> {
  const owner = getSession()?.userId;
  if (!owner) return [];
  return (await allDrafts()).filter(draft => draft.ownerId === owner);
}

export async function countUnclaimedDrafts(): Promise<number> {
  if (!getSession()) return 0;
  return (await allDrafts()).filter(draft => !draft.ownerId).length;
}

// Importing is explicit: token possession on this device grants existing report access.
export async function claimDeviceDrafts(): Promise<void> {
  const owner = getSession()?.userId;
  if (!owner) throw new Error("Sign in to import reports from this device.");
  for (const draft of await allDrafts()) {
    if (!draft.ownerId) await saveDraft(draft, owner);
  }
}

async function saveDraft(draft: ReportDraft, importOwner?: string) {
  return serialize(draft.id, async () => {
    const stored = await storedDraft(draft.id);
    const saved = importOwner && stored
      ? { ...stored, ownerId: stored.ownerId ?? importOwner }
      : { ...draft, ownerId: stored?.ownerId ?? draft.ownerId };
    const previous = metadataFiles().filter(record => record.id === draft.id);
    const revision = (previous[0]?.revision ?? 0) + 1;
    const dir = directory();
    const temporary = new File(dir, `${draft.id}.${revision}.tmp`);
    const published = new File(dir, `${draft.id}.${revision}.json`);
    // Publish a fully written revision by a same-directory rename. Never overwrite
    // committed JSON: Expo's overwrite move deletes the old destination first on iOS.
    await temporary.write(JSON.stringify(saved));
    await temporary.move(published);
    // A crash before cleanup leaves two valid revisions; readers choose the newest.
    for (const record of previous) {
      try { record.file.delete(); } catch { /* A superseded revision is harmless. */ }
    }
  });
}

async function credential(draft: ReportDraft) {
  const stored = await storedDraft(draft.id);
  if (!stored) throw new Error("This saved report is no longer available on this device.");
  if (stored.ownerId && stored.ownerId !== getSession()?.userId) throw new Error("Sign in to the account that saved this report.");
  const token = await SecureStore.getItemAsync(tokenKey(draft.id));
  if (!token) throw new Error("The private access key for this report is unavailable on this device.");
  return token;
}

export async function sendDraft(draft: ReportDraft) {
  return sendSavedDraft(draft, await credential(draft), new File(draft.photoUri), request, saveDraft);
}

export async function discardDraft(draft: ReportDraft) {
  return serialize(draft.id, async () => {
    const stored = await storedDraft(draft.id);
    if (!stored) throw new Error("This saved report is no longer available on this device.");
    await discardRejectedDraft(stored, await credential(stored), request, async () => {
      for (const file of directory().list()) {
        const name = file.uri.split("/").at(-1) ?? "";
        if (file instanceof File && name.startsWith(`${stored.id}.`) && name.endsWith(".tmp")) file.delete();
      }
      const photo = new File(stored.photoUri);
      if (photo.exists) photo.delete();
      // Delete old revisions first so an interrupted discard cannot reveal an older owner.
      for (const record of metadataFiles().filter(record => record.id === draft.id).reverse()) record.file.delete();
      await SecureStore.deleteItemAsync(tokenKey(stored.id));
    });
  });
}

export async function refreshReport(draft: ReportDraft) {
  const report = await readReport(draft, await credential(draft), request);
  if (report) {
    const { rejection: _rejection, ...saved } = draft;
    await saveDraft({ ...saved, reference: report.public_reference });
  }
  return report;
}

export async function reportUpdates(draft: ReportDraft, offset = 0) {
  return readReportUpdates(draft, await credential(draft), offset, request);
}
export async function reportPhoto(draft: ReportDraft, photoId: string) {
  return readPhotoAccess(draft, await credential(draft), photoId, request);
}
