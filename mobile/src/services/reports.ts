import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { discardRejectedDraft, readReport, residentToken, sendSavedDraft, type ReportDraft, type Transport } from "./report-client";

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
  await new File(dir, `${id}.json`).write(JSON.stringify(draft));
  return draft;
}

async function allDrafts(): Promise<ReportDraft[]> {
  const files = directory().list().filter((item): item is File => item instanceof File && item.extension === ".json");
  return Promise.all(files.map(async file => JSON.parse(await file.text()) as ReportDraft));
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
    if (!draft.ownerId) await saveDraft({ ...draft, ownerId: owner });
  }
}

async function saveDraft(draft: ReportDraft) {
  const file = new File(directory(), `${draft.id}.json`);
  const stored: ReportDraft | undefined = file.exists ? JSON.parse(await file.text()) : undefined;
  await file.write(JSON.stringify({ ...draft, ownerId: stored?.ownerId ?? draft.ownerId }));
}

async function credential(draft: ReportDraft) {
  const stored: ReportDraft = JSON.parse(await new File(directory(), `${draft.id}.json`).text());
  if (stored.ownerId && stored.ownerId !== getSession()?.userId) throw new Error("Sign in to the account that saved this report.");
  const token = await SecureStore.getItemAsync(tokenKey(draft.id));
  if (!token) throw new Error("The private access key for this report is unavailable on this device.");
  return token;
}

export async function sendDraft(draft: ReportDraft) {
  return sendSavedDraft(draft, await credential(draft), new File(draft.photoUri), request, saveDraft);
}

export async function discardDraft(draft: ReportDraft) {
  const stored: ReportDraft = JSON.parse(await new File(directory(), `${draft.id}.json`).text());
  await discardRejectedDraft(stored, await credential(stored), request, async () => {
    const photo = new File(stored.photoUri);
    if (photo.exists) photo.delete();
    new File(directory(), `${stored.id}.json`).delete();
    await SecureStore.deleteItemAsync(tokenKey(stored.id));
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
