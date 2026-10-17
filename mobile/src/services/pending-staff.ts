import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { getSession } from "@/auth/session";
import { staffApi } from "./staff";
import { StaffApiError, type Job } from "./staff-client";
import { recoverOrSend, type StaffCommand } from "./staff-commands";

const apiUrl = () => process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/+$/, "") ?? "";
function directory() {
  if (Platform.OS === "web") throw new Error("Use the native app for durable crew submissions.");
  const directory = new Directory(Paths.document, "wastegrid-staff");
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}
function records() {
  return directory().list().flatMap(file => {
    const match = /([^.\/]+)\.(\d+)\.json$/.exec(file.uri);
    return file instanceof File && match ? [{ file, id: match[1], revision: Number(match[2]) }] : [];
  }).sort((a, b) => b.revision - a.revision);
}
function authorised(command: StaffCommand) {
  const session = getSession();
  if (!session || session.userId !== command.ownerId || session.crewId !== command.crewId || command.apiUrl !== apiUrl() ||
    (["dispatch", "release"].includes(command.kind) ? session.role !== "admin" : session.role !== "crew")) {
    throw new Error("Sign in to the staff account that saved this action.");
  }
}
export async function pendingStaff(): Promise<StaffCommand[]> {
  const newest = new Map<string, ReturnType<typeof records>[number]>();
  for (const record of records()) if (!newest.has(record.id)) newest.set(record.id, record);
  const commands: StaffCommand[] = [];
  for (const record of newest.values()) {
    try {
      const command: StaffCommand = JSON.parse(await record.file.text());
      if (!command || command.command_id !== record.id || !["start", "dispatch", "completion", "release"].includes(command.kind) ||
          typeof command.resource_id !== "string" || typeof command.ownerId !== "string" || typeof command.apiUrl !== "string" ||
          (command.kind !== "dispatch" && (!Number.isSafeInteger(command.expected_version) || command.expected_version! < 1)) ||
          (["start", "completion"].includes(command.kind) && typeof command.crewId !== "string") ||
          (command.kind === "completion" && typeof command.photoUri !== "string") ||
          (command.kind === "release" && !command.reason?.trim())) continue;
      authorised(command); commands.push(command);
    } catch { /* Keep corrupt and other-account records private and intact. */ }
  }
  return commands;
}
async function save(command: StaffCommand) {
  const previous = records().filter(record => record.id === command.command_id);
  const revision = (previous[0]?.revision ?? 0) + 1;
  const temporary = new File(directory(), `${command.command_id}.${revision}.tmp`);
  await temporary.write(JSON.stringify(command));
  await temporary.move(new File(directory(), `${command.command_id}.${revision}.json`));
  for (const record of previous) { try { record.file.delete(); } catch { /* Newest revision wins. */ } }
}
let mutation = Promise.resolve<unknown>(undefined);
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = mutation.catch(() => {}).then(work);
  mutation = next;
  return next;
}
export function prepareStaff(kind: StaffCommand["kind"], resource: string | Job, photoUri?: string, reason?: string): Promise<StaffCommand> {
  const owner = getSession();
  return serial(async () => {
    if (!owner || getSession() !== owner) throw new Error("Your account changed. Try again.");
    const id = typeof resource === "string" ? resource : resource.id;
    const commands = await pendingStaff();
    if (getSession() !== owner) throw new Error("Your account changed. Try again.");
    const existing = commands.find(command => command.kind === kind && command.resource_id === id);
    if (existing) return existing;
    const command: StaffCommand = { command_id: Crypto.randomUUID(), kind, resource_id: id, ownerId: owner.userId,
      crewId: owner.crewId, apiUrl: apiUrl(), ...(typeof resource !== "string" ? { expected_version: resource.version } : {}), ...(reason ? { reason } : {}) };
    authorised(command);
    if (kind === "completion") {
      if (!photoUri) throw new Error("Capture a cleanup photo first.");
      const source = new File(photoUri);
      if (!source.exists || source.size > 8 * 1024 * 1024 || ![".jpg", ".jpeg", ".png", ".webp"].includes(source.extension.toLowerCase())) throw new Error("Use a JPEG, PNG or WebP photo below 8 MiB.");
      const photo = new File(directory(), `${command.command_id}${source.extension}`);
      await source.copy(photo); command.photoUri = photo.uri;
    }
    // Persist before HTTP. A session change preserves the original owner's action.
    await save(command); authorised(command);
    return command;
  });
}
function remove(command: StaffCommand) {
  for (const record of records().filter(record => record.id === command.command_id).reverse()) record.file.delete();
  if (command.photoUri) { const photo = new File(command.photoUri); if (photo.exists) photo.delete(); }
}
const running = new Map<string, Promise<unknown>>();
export function submitStaff(command: StaffCommand): Promise<unknown> {
  const existing = running.get(command.command_id);
  if (existing) return existing;
  const work = (async () => {
    authorised(command);
    try {
      const result = await recoverOrSend(command, staffApi, command.photoUri ? new File(command.photoUri) : undefined);
      await serial(async () => { try { remove(command); } catch { /* Retry recovers the accepted command if cleanup failed. */ } });
      return result;
    } catch (error) {
      if (error instanceof StaffApiError && [409, 413, 415, 422].includes(error.status)) {
        await serial(() => save({ ...command, rejected: true }));
      }
      throw error;
    }
  })().finally(() => { running.delete(command.command_id); });
  running.set(command.command_id, work);
  return work;
}
export function discardRejectedStaff(command: StaffCommand) {
  return serial(async () => {
    authorised(command);
    if (!command.rejected || running.has(command.command_id)) throw new Error("Only a rejected submission can be discarded. Retry uncertain actions with their saved identity.");
    if (command.kind === "dispatch") {
      const preview = await staffApi.preview(command.resource_id);
      if (preview.plan_id) throw new Error("This preview was dispatched. Recover the saved action instead.");
      remove(command); return;
    }
    const details = await staffApi.job(command.resource_id);
    if (details.events.some(event => event.command_id === command.command_id)) throw new Error("The server accepted this action. Retry to recover it instead.");
    remove(command);
  });
}
