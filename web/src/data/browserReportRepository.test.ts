import { beforeEach, expect, test } from "vitest";

import {
  BrowserReportRepository,
  ReportStorageError,
} from "./browserReportRepository";

beforeEach(() => {
  window.localStorage.clear();
});

function createStorage(overrides: Partial<Storage>): Storage {
  return {
    length: 0,
    clear: () => undefined,
    getItem: () => null,
    key: () => null,
    removeItem: () => undefined,
    setItem: () => undefined,
    ...overrides,
  };
}

test("creates a report and makes it retrievable by its generated reference", () => {
  const repository = new BrowserReportRepository(window.localStorage);

  const report = repository.create({
    title: "Overflowing bin",
    address: "14 Market Street",
  });

  expect(report.reference).toMatch(/^WG-/);
  expect(repository.getByReference(report.reference)).toEqual(report);
});

test("remembers a selected report across repository instances", () => {
  const first = new BrowserReportRepository(window.localStorage);
  const report = first.create({ title: "Fly tipping", address: "Central Park" });
  first.remember(report.reference);

  const second = new BrowserReportRepository(window.localStorage);

  expect(second.getRememberedReference()).toBe(report.reference);
});

test("rejects report creation without a title or address", () => {
  const repository = new BrowserReportRepository(window.localStorage);

  expect(() => repository.create({ title: "", address: "14 Market Street" })).toThrow(
    "Report title is required",
  );
  expect(() => repository.create({ title: "Overflowing bin", address: "" })).toThrow(
    "Report address is required",
  );
});

test("raises a clear error when browser storage cannot be read", () => {
  const unavailableStorage = createStorage({
    getItem: () => {
      throw new Error("storage disabled");
    },
  });
  const repository = new BrowserReportRepository(unavailableStorage);

  expect(() => repository.list()).toThrow(ReportStorageError);
  expect(() => repository.list()).toThrow("Report storage is unavailable");
});

test("raises a clear error when storing a remembered report fails", () => {
  const unavailableStorage = createStorage({
    getItem: () => JSON.stringify([{ reference: "WG-TEST" }]),
    setItem: () => {
      throw new Error("storage disabled");
    },
  });
  const repository = new BrowserReportRepository(unavailableStorage);

  expect(() => repository.remember("WG-TEST")).toThrow(ReportStorageError);
  expect(() => repository.remember("WG-TEST")).toThrow("Report storage is unavailable");
});

test("resets malformed stored report data to the demo report", () => {
  const writes: string[] = [];
  const storage = createStorage({
    getItem: () => "not-json",
    setItem: (_key, value) => writes.push(value),
  });
  const repository = new BrowserReportRepository(storage);

  expect(repository.list()).toEqual([expect.objectContaining({ reference: "WG-DEMO" })]);
  expect(writes).toHaveLength(1);
});

test("resets non-list stored report data to the demo report", () => {
  const writes: string[] = [];
  const storage = createStorage({
    getItem: () => JSON.stringify({ reference: "WG-NOT-A-LIST" }),
    setItem: (_key, value) => writes.push(value),
  });
  const repository = new BrowserReportRepository(storage);

  expect(repository.list()).toEqual([expect.objectContaining({ reference: "WG-DEMO" })]);
  expect(writes).toHaveLength(1);
});

test("does not remember an unknown report reference", () => {
  const repository = new BrowserReportRepository(window.localStorage);

  repository.remember("WG-UNKNOWN");

  expect(repository.getRememberedReference()).toBeUndefined();
});
