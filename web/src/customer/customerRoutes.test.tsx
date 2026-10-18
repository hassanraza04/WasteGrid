import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, test } from "vitest";

import { BrowserReportRepository } from "../data/browserReportRepository";
import type { ReportRepository } from "../data/reportRepository";
import { CustomerHomePage } from "./CustomerHomePage";
import { CreateReportPage } from "./CreateReportPage";
import { TrackReportPage } from "./TrackReportPage";
import { ReportDetailPage } from "./ReportDetailPage";

beforeEach(() => {
  window.localStorage.clear();
});

function renderAppAt(path: string, repository: ReportRepository): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      {/* Archived local prototype components; these routes are not mounted by LiveApp. */}
      <Routes>
        <Route path="/" element={<CustomerHomePage repository={repository} />} />
        <Route path="/report/new" element={<CreateReportPage repository={repository} />} />
        <Route path="/report/track" element={<TrackReportPage />} />
        <Route path="/report/:reference" element={<ReportDetailPage repository={repository} />} />
      </Routes>
    </MemoryRouter>,
  );
}

test("restores the remembered report from the public home route", () => {
  const repository = new BrowserReportRepository(window.localStorage);
  repository.remember("WG-DEMO");

  renderAppAt("/", repository);

  expect(screen.getByRole("heading", { name: "Report WG-DEMO" })).toBeInTheDocument();
});

test("creates a report and navigates to its detail page", async () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const user = userEvent.setup();
  renderAppAt("/report/new", repository);

  await user.type(screen.getByLabelText("What needs attention?"), "Overflowing bin");
  await user.type(screen.getByLabelText("Address"), "14 Market Street");
  await user.click(screen.getByRole("button", { name: "Create report" }));

  expect(await screen.findByRole("heading", { name: /Report WG-/ })).toBeInTheDocument();
  expect(screen.getByText("Overflowing bin")).toBeInTheDocument();
});

test("tracks a report by reference", async () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const user = userEvent.setup();
  renderAppAt("/report/track", repository);

  await user.type(screen.getByLabelText("Report reference"), "wg-demo");
  await user.click(screen.getByRole("button", { name: "Track report" }));

  expect(await screen.findByRole("heading", { name: "Report WG-DEMO" })).toBeInTheDocument();
});

test("shows a clear not-found state for an unknown report", () => {
  const repository = new BrowserReportRepository(window.localStorage);

  renderAppAt("/report/UNKNOWN", repository);

  expect(screen.getByRole("heading", { name: "Report not found" })).toBeInTheDocument();
});

test("renders a fallback error when report creation throws a non-Error value", async () => {
  const repository: ReportRepository = {
    list: () => [],
    getByReference: () => undefined,
    create: () => {
      throw "unexpected failure";
    },
    remember: () => undefined,
    getRememberedReference: () => undefined,
  };
  const user = userEvent.setup();
  renderAppAt("/report/new", repository);

  await user.click(screen.getByRole("button", { name: "Create report" }));

  expect(screen.getByRole("alert")).toHaveTextContent("Unable to create report");
});
