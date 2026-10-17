import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Directory, File, Paths } from "expo-file-system";
import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import { readReport, residentToken, uploadReport, type ReportDraft, type Transport } from "./report-client";

const request: Transport = (url, init) => fetch(url, init);
function directory() {
  if (Platform.OS === "web") throw new Error("Use the mobile app to save reports securely on this device.");
  const dir = new Directory(Paths.document, "wastegrid-reports");
  dir.create({ idempotent: true, intermediates: true });
  return dir;
}
const tokenKey = (id: string) => `wastegrid.report.${id}`;

export async function createDraft(photoUri: string, fields: Record<string, string>): Promise<ReportDraft> {
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
  const draft: ReportDraft = { id, apiUrl, photoUri: destination.uri, mime, fields };
  await new File(dir, `${id}.json`).write(JSON.stringify(draft));
  return draft;
}

export async function listDrafts(): Promise<ReportDraft[]> {
  const files = directory().list().filter((item): item is File => item instanceof File && item.extension === ".json");
  return Promise.all(files.map(async file => JSON.parse(await file.text()) as ReportDraft));
}

async function credential(draft: ReportDraft) {
  const token = await SecureStore.getItemAsync(tokenKey(draft.id));
  if (!token) throw new Error("The private access key for this report is unavailable on this device.");
  return token;
}

export async function sendDraft(draft: ReportDraft) {
  const token = await credential(draft);
  const report = await uploadReport(draft, token, new File(draft.photoUri), request);
  await new File(directory(), `${draft.id}.json`).write(JSON.stringify({ ...draft, reference: report.public_reference }));
  return report;
}

export async function refreshReport(draft: ReportDraft) {
  return readReport(draft, await credential(draft), request);
}
