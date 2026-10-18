import { IDBFactory, IDBDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { emptyJournal, readJournal, writeJournal, JournalUnavailable, sameScope, matchingReceipt } from "./dispatchJournal";
import { ACTOR, COMMAND, ENVIRONMENT, routePreview, committedPreview } from "../test/routingFixtures";
beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function entry() { return { ...emptyJournal(), crewIds: ["crew-1"], jobIds: ["job-1"], previewId: "preview-1", commandId: COMMAND, stage: "attempted" as const }; }
test("durably stores a cloned command and isolates accounts and API environments", async () => {
  expect(await readJournal(ENVIRONMENT, ACTOR)).toBeNull();
  const source = entry(); await writeJournal(ENVIRONMENT, ACTOR, source); source.jobIds.push("other");
  expect((await readJournal(ENVIRONMENT + "/", ACTOR))?.jobIds).toEqual(["job-1"]);
  expect(await readJournal(ENVIRONMENT, "other-actor")).toBeNull();
  expect(await readJournal("https://other.invalid", ACTOR)).toBeNull();
  const a = emptyJournal(); a.constraints.max_stops_per_crew = 1;
  expect(emptyJournal().constraints.max_stops_per_crew).toBe(10);
});
test.each([["", ACTOR], [ENVIRONMENT, ""]])("rejects unverified partition %s %s", async (environment, actor) => {
  await expect(readJournal(environment, actor)).rejects.toBeInstanceOf(JournalUnavailable);
  await expect(writeJournal(environment, actor, entry())).rejects.toBeInstanceOf(JournalUnavailable);
});
test("missing or failed IndexedDB blocks reads and writes", async () => {
  vi.stubGlobal("indexedDB", undefined);
  await expect(readJournal(ENVIRONMENT, ACTOR)).rejects.toBeInstanceOf(JournalUnavailable);
  await expect(writeJournal(ENVIRONMENT, ACTOR, entry())).rejects.toBeInstanceOf(JournalUnavailable);
  const request = {} as IDBOpenDBRequest;
  vi.stubGlobal("indexedDB", { open: () => { queueMicrotask(() => request.onerror?.(new Event("error"))); return request; } });
  await expect(readJournal(ENVIRONMENT, ACTOR)).rejects.toBeInstanceOf(JournalUnavailable);
});
test.each(["readonly", "readwrite"] as const)("an aborted %s transaction never signals durable success", async mode => {
  await writeJournal(ENVIRONMENT, ACTOR, entry());
  const original = IDBDatabase.prototype.transaction;
  vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(function(this: IDBDatabase, ...args: Parameters<typeof original>) {
    const transaction = original.apply(this, args); queueMicrotask(() => transaction.abort()); return transaction;
  });
  const operation = mode === "readonly" ? readJournal(ENVIRONMENT, ACTOR) : writeJournal(ENVIRONMENT, ACTOR, entry());
  await expect(operation).rejects.toBeInstanceOf(JournalUnavailable);
});
test.each([
  { version: 2 }, { crewIds: ["crew-1", "crew-1"] }, { jobIds: [42] }, { crewIds: [] },
  { constraints: {} }, { constraints: { ...emptyJournal().constraints, max_duration_minutes: -1 } },
  { constraints: { ...emptyJournal().constraints, max_duration_minutes: 481 } },
  { constraints: { ...emptyJournal().constraints, max_stops_per_crew: 26 } },
  { acceptPartial: "yes" }, { stage: "bad" }, { commandId: null }, { previewId: null },
])("rejects corrupt persisted state %j before restoring it", async malformed => {
  await writeJournal(ENVIRONMENT, ACTOR, { ...entry(), ...malformed } as never);
  await expect(readJournal(ENVIRONMENT, ACTOR)).rejects.toBeInstanceOf(JournalUnavailable);
});
test("validates exact job, crew and constraint scope without widening", () => {
  const result = routePreview(), saved = entry(); expect(sameScope(result, saved)).toBe(true);
  const variants = [
    { ...result, job_ids: null }, { ...result, routes: undefined }, { ...result, metrics: undefined },
    { ...result, expires_at: "bad" }, { ...result, settings: {} }, { ...result, job_ids: ["other"] }, { ...result, id: "other-preview" },
    { ...result, routes: [result.routes[0], { ...result.routes[0], stops: [] }] },
    { ...result, routes: [{ ...result.routes[0], stops: [] }] },
    { ...result, routes: [{ ...result.routes[0], crew_id: "other" }] },
    { ...result, routes: [{ ...result.routes[0], stops: [...result.routes[0].stops, ...result.routes[0].stops] }] },
    { ...result, unassigned: [{ job_id: "other", reason: "held" }] },
    { ...result, reassignments: [{ job_id: "job-1", previous_crew_id: null, previous_position: null, proposed_crew_id: "other", proposed_position: 0 }] },
  ]; variants.forEach(candidate => expect(sameScope(candidate as never, saved)).toBe(false));
});
test("receipt correlation requires original preview, command, actor, plan and partial consent", () => {
  const result = committedPreview(), saved = entry(); expect(matchingReceipt(result, saved, ACTOR)).toBe(true);
  expect(matchingReceipt(routePreview(), saved, ACTOR)).toBe(false);
  expect(matchingReceipt({ ...result, id: "other" }, saved, ACTOR)).toBe(false);
  expect(matchingReceipt(result, { ...saved, commandId: "other" }, ACTOR)).toBe(false);
  expect(matchingReceipt(result, saved, "other")).toBe(false);
  expect(matchingReceipt({ ...result, plan_id: "other" }, saved, ACTOR)).toBe(false);
  expect(matchingReceipt(result, { ...saved, acceptPartial: true }, ACTOR)).toBe(false);
});


test.each([false, 0, ""])("rejects a falsy malformed stored value %j", async value => {
  await writeJournal(ENVIRONMENT, ACTOR, value as never);
  await expect(readJournal(ENVIRONMENT, ACTOR)).rejects.toBeInstanceOf(JournalUnavailable);
});


test("a stale tab cannot overwrite a durable attempted command or its original scope", async () => {
  const original = entry(); await writeJournal(ENVIRONMENT, ACTOR, original);
  for (const replacement of [emptyJournal(), { ...original, commandId: "replacement" }, { ...original, jobIds: ["different"] }, { ...original, acceptPartial: true }, { ...original, constraints: { ...original.constraints, max_stops_per_crew: 5 } }]) {
    await expect(writeJournal(ENVIRONMENT, ACTOR, replacement)).rejects.toThrow("Another tab has an unconfirmed dispatch");
    expect(await readJournal(ENVIRONMENT, ACTOR)).toEqual(original);
  }
  await writeJournal(ENVIRONMENT, ACTOR, original);
  await writeJournal(ENVIRONMENT, ACTOR, { ...original, stage: "committed" });
  expect((await readJournal(ENVIRONMENT, ACTOR))?.stage).toBe("committed");
});
test("two competing tabs atomically preserve exactly one attempted identity", async () => {
  const first = entry(), second = { ...entry(), commandId: "other-command" };
  const results = await Promise.allSettled([writeJournal(ENVIRONMENT, ACTOR, first), writeJournal(ENVIRONMENT, ACTOR, second)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const retained = await readJournal(ENVIRONMENT, ACTOR);
  expect([COMMAND, "other-command"]).toContain(retained?.commandId);
  expect(retained?.stage).toBe("attempted");
});
