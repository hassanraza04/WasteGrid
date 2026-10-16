import { beforeEach, expect, test } from "vitest";

import { BrowserReportRepository } from "./browserReportRepository";

beforeEach(() => {
  window.localStorage.clear();
});

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
