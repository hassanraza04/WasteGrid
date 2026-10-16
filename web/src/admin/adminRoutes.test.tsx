import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test } from "vitest";

import { App } from "../app/App";
import { BrowserAdminSession } from "../auth/browserAdminSession";
import { BrowserReportRepository } from "../data/browserReportRepository";

beforeEach(() => {
  window.localStorage.clear();
});

function renderAppAt(
  path: string,
  repository: BrowserReportRepository,
  adminSession: BrowserAdminSession,
): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App repository={repository} adminSession={adminSession} />
    </MemoryRouter>,
  );
}

test("redirects an unsigned-in organizer to sign-in", () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const session = new BrowserAdminSession(window.localStorage);

  renderAppAt("/admin", repository, session);

  expect(screen.getByRole("heading", { name: "Organizer sign in" })).toBeInTheDocument();
});

test("renders the organizer dashboard after the local sign-in action", async () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const session = new BrowserAdminSession(window.localStorage);
  const user = userEvent.setup();
  renderAppAt("/admin/sign-in", repository, session);

  await user.click(screen.getByRole("button", { name: "Continue as organizer" }));

  expect(await screen.findByRole("heading", { name: "Organizer dashboard" })).toBeInTheDocument();
  expect(screen.getByText("WG-DEMO")).toBeInTheDocument();
});

test("returns an organizer to sign-in after sign-out", async () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const session = new BrowserAdminSession(window.localStorage);
  session.signIn();
  const user = userEvent.setup();
  renderAppAt("/admin", repository, session);

  await user.click(screen.getByRole("button", { name: "Sign out" }));

  expect(await screen.findByRole("heading", { name: "Organizer sign in" })).toBeInTheDocument();
});
