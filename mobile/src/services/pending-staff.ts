import * as Crypto from "@/utils/secure-random";
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { getSession } from "@/auth/session";
import { staffApi } from "./staff";
import { StaffApiError, type Job } from "./staff-client";
import { recoverOrSend, type StaffCommand } from "./staff-commands";

const knownDispatchConflicts = new Set<string>();
const unknownDispatch = () => new Error("Dispatch confirmation is still unknown. Keep the saved action and check its result; do not resubmit this preview.");
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
async function savedStaff(): Promise<StaffCommand[]> {
  const newest = new Map<string, ReturnType<typeof records>[number]>();
  for (const record of records()) if (!newest.has(record.id)) newest.set(record.id, record);
  const commands: StaffCommand[] = [];
  for (const record of newest.values()) {
    try {
      const command: StaffCommand = JSON.parse(await record.file.text());
      if (!command || command.command_id !== record.id || !["start", "dispatch", "completion", "release"].includes(command.kind) ||
          typeof command.resource_id !== "string" || typeof command.ownerId !== "string" || typeof command.apiUrl !== "string" ||
          (command.recomputeRequired !== undefined && typeof command.recomputeRequired !== "boolean") ||
          (command.reconciled !== undefined && typeof command.reconciled !== "boolean") ||
          (command.dispatchAttemptPending !== undefined && typeof command.dispatchAttemptPending !== "boolean") ||
          (command.kind !== "dispatch" && (!Number.isSafeInteger(command.expected_version) || command.expected_version! < 1)) ||
          (["start", "completion"].includes(command.kind) && typeof command.crewId !== "string") ||
          (command.kind === "completion" && command.photoUri !== undefined && (typeof command.photoUri !== "string" || !command.photoUri.trim())) ||
          (command.kind === "release" && !command.reason?.trim())) continue;
      if (command.kind === "dispatch" && knownDispatchConflicts.has(command.command_id)) {
        command.rejected = true; command.recomputeRequired = true;
      }
      // Older builds stored definitive dispatch rejections without their status.
      if (command.kind === "dispatch" && command.rejected && command.recomputeRequired === undefined) command.recomputeRequired = true;
      authorised(command); commands.push(command);
    } catch { /* Keep corrupt and other-account records private and intact. */ }
  }
  return commands;
}
export async function pendingStaff(): Promise<StaffCommand[]> {
  return (await savedStaff()).filter(command => !command.reconciled);
}
function terminalDispatch(command: StaffCommand) {
  return command.kind === "dispatch" && (command.recomputeRequired || command.reconciled);
}
function requireFreshDispatch(command: StaffCommand) {
  if (terminalDispatch(command)) throw new Error("This preview was rejected. Refresh routing state and compute a new preview.");
  if (command.kind === "dispatch" && command.dispatchAttemptPending) throw unknownDispatch();
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
    const commands = await savedStaff();
    if (getSession() !== owner) throw new Error("Your account changed. Try again.");
    const existing = commands.find(command => command.kind === kind && command.resource_id === id);
    if (existing) { requireFreshDispatch(existing); return existing; }
    const command: StaffCommand = { command_id: Crypto.randomUUID(), kind, resource_id: id, ownerId: owner.userId,
      crewId: owner.crewId, apiUrl: apiUrl(), ...(typeof resource !== "string" ? { expected_version: resource.version } : {}), ...(reason ? { reason } : {}) };
    authorised(command);
    if (kind === "completion" && photoUri !== undefined) {
      if (!photoUri.trim()) throw new Error("Choose a valid cleanup photo or complete without one.");
      const source = new File(photoUri);
      if (!source.exists || source.size <= 0 || source.size > 8 * 1024 * 1024 || ![".jpg", ".jpeg", ".png", ".webp"].includes(source.extension.toLowerCase())) throw new Error("Use a JPEG, PNG or WebP photo below 8 MiB.");
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
  // A cached in-flight promise is still private to the account that initiated it.
  try { authorised(command); } catch (error) { return Promise.reject(error); }
  const existing = running.get(command.command_id);
  if (existing) return existing;
  const work = (async () => {
    const saved = await serial(async () => {
      authorised(command);
      const record = (await savedStaff()).find(item => item.command_id === command.command_id);
      authorised(command);
      return record;
    });
    authorised(command);
    if (!saved) throw new Error("The saved action is unavailable. Refresh your pending actions before retrying.");
    const current = saved;
    if (current.kind !== command.kind || current.resource_id !== command.resource_id) throw new Error("The saved action identity changed. Refresh your pending actions.");
    if (current.kind === "dispatch" && current.dispatchAttemptPending && !terminalDispatch(current)) return reconcileDispatch(current, true);
    requireFreshDispatch(current);
    let dispatchAttempted = false;
    try {
      const result = await recoverOrSend(current, staffApi, current.photoUri ? new File(current.photoUri) : undefined, async () => {
        await serial(async () => {
          authorised(current);
          await save({ ...current, rejected: false, recomputeRequired: false, dispatchAttemptPending: true });
          authorised(current);
        });
        dispatchAttempted = true;
      });
      await serial(async () => { try { remove(current); } catch { /* Retry recovers the accepted command if cleanup failed. */ } });
      return result;
    } catch (error) {
      const rejected = error instanceof StaffApiError && [409, 413, 415, 422].includes(error.status);
      const conflict = current.kind === "dispatch" && dispatchAttempted && error instanceof StaffApiError && error.status === 409;
      if (conflict) knownDispatchConflicts.add(current.command_id);
      if (rejected || dispatchAttempted) {
        try {
          await serial(async () => {
            if (dispatchAttempted) authorised(current);
            await save({ ...current,
              ...(rejected ? { rejected: true } : dispatchAttempted ? { rejected: false } : {}),
              ...(current.kind === "dispatch" ? { recomputeRequired: conflict, dispatchAttemptPending: false } : {}),
            });
          });
        } catch (storageError) {
          // The pre-POST barrier survives an interrupted outcome checkpoint.
          // Preserve the transport error so the UI invalidates a definite 409.
          if (!dispatchAttempted) throw storageError;
        }
      }
      throw error;
    }
  })().finally(() => { running.delete(command.command_id); });
  running.set(command.command_id, work);
  return work;
}
export function reconcileDispatchConflict(command: StaffCommand): Promise<{ plan_id: string | null }> {
  return reconcileDispatch(command, false);
}
function reconcileDispatch(command: StaffCommand, recoveringAttempt: boolean): Promise<{ plan_id: string | null }> {
  return serial(async () => {
    authorised(command);
    let current = (await savedStaff()).find(record => record.command_id === command.command_id);
    authorised(command);
    if (!current || current.kind !== "dispatch" || (!terminalDispatch(current) && !current.dispatchAttemptPending) ||
        current.resource_id !== command.resource_id || (!recoveringAttempt && running.has(command.command_id))) {
      throw new Error("Only a rejected or interrupted dispatch can be reconciled. Keep uncertain actions for recovery.");
    }
    const knownConflict = !!terminalDispatch(current);
    if (knownConflict && current.dispatchAttemptPending) {
      // A definite 409 can outlive a failed checkpoint in this process.
      current = { ...current, rejected: true, recomputeRequired: true, dispatchAttemptPending: false };
      await save(current);
      authorised(current);
    }
    const [preview] = await Promise.all([
      staffApi.preview(current.resource_id).catch(error => {
        if (error instanceof StaffApiError && error.status === 404) return null;
        throw error;
      }),
      staffApi.currentPlan(),
    ]);
    authorised(current);
    if (!knownConflict && !preview?.plan_id) throw unknownDispatch();
    // A missing preview is safe to retire only for a definite rejection and
    // after successfully reading the current authoritative routing state.
    // An observed plan can belong to another organiser; this is reconciliation.
    await save({ ...current, dispatchAttemptPending: false, reconciled: true });
    authorised(current);
    return { plan_id: preview?.plan_id ?? null };
  });
}
export function discardRejectedStaff(command: StaffCommand) {
  return serial(async () => {
    authorised(command);
    const current = (await savedStaff()).find(record => record.command_id === command.command_id);
    authorised(command);
    if (current && (terminalDispatch(current) || (current.kind === "dispatch" && current.dispatchAttemptPending))) throw new Error("Refresh routing state to reconcile this dispatch.");
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
