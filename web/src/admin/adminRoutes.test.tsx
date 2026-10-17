import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test } from "vitest";

import { App } from "../app/App";
import type { OrganizerSession } from "../auth/organizerSession";
import {
  type OrganizerApi,
  OrganizerApiError,
  type OrganizerIdentity,
  type OrganizerReport,
} from "../data/organizerApi";

class FakeOrganizerSession implements OrganizerSession {
  public token: string | undefined;
  public signInError: Error | undefined;
  public signOutCalls = 0;

  public async signIn(email: string, password: string): Promise<void> {
    if (this.signInError) {
      throw this.signInError;
    }
    if (email === "organizer@example.test" && password === "correct-password") {
      this.token = "access-token";
    }
  }

  public async getAccessToken(): Promise<string | undefined> {
    return this.token;
  }

  public async signOut(): Promise<void> {
    this.signOutCalls += 1;
    this.token = undefined;
  }
}

class FakeOrganizerApi implements OrganizerApi {
  public identity: OrganizerIdentity = { role: "organizer" };
  public reports: OrganizerReport[] = [
    {
      id: "report-id",
      publicReference: "WG-A1B2C3D4E5F6",
      title: "Overflowing bin",
      dashboardStatus: "submitted",
      address: null,
    },
  ];
  public listReportsCalls = 0;
  public reportError: Error | undefined;

  public async getIdentity(): Promise<OrganizerIdentity> {
    return this.identity;
  }

  public async listReports(): Promise<OrganizerReport[]> {
    this.listReportsCalls += 1;
    if (this.reportError) {
      const error = this.reportError;
      this.reportError = undefined;
      throw error;
    }
    return this.reports;
  }
}

beforeEach(() => {
  window.localStorage.clear();
});

function renderHostedAppAt(
  path: string,
  session = new FakeOrganizerSession(),
  api = new FakeOrganizerApi(),
): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App organizer={{ session, api }} />
    </MemoryRouter>,
  );
}

test("signs an organizer in and loads hosted reports", async () => {
  const user = userEvent.setup();
  renderHostedAppAt("/admin/sign-in");

  await user.type(screen.getByLabelText("Email"), "organizer@example.test");
  await user.type(screen.getByLabelText("Password"), "correct-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByText("WG-A1B2C3D4E5F6")).toBeInTheDocument();
  expect(screen.getByText("Overflowing bin")).toBeInTheDocument();
});

test("shows invalid-credential feedback without leaving sign-in", async () => {
  const session = new FakeOrganizerSession();
  session.signInError = new Error("Invalid login credentials");
  const user = userEvent.setup();
  renderHostedAppAt("/admin/sign-in", session);

  await user.type(screen.getByLabelText("Email"), "organizer@example.test");
  await user.type(screen.getByLabelText("Password"), "wrong-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
  expect(screen.getByRole("heading", { name: "Organizer sign in" })).toBeInTheDocument();
});

test("returns a non-organizer to sign-in without loading reports", async () => {
  const session = new FakeOrganizerSession();
  session.token = "crew-token";
  const api = new FakeOrganizerApi();
  api.identity = { role: "crew" };
  renderHostedAppAt("/admin", session, api);

  expect(await screen.findByRole("heading", { name: "Organizer sign in" })).toBeInTheDocument();
  expect(api.listReportsCalls).toBe(0);
});

test("shows a retryable reports failure for an authenticated organizer", async () => {
  const session = new FakeOrganizerSession();
  session.token = "access-token";
  const api = new FakeOrganizerApi();
  api.reportError = new OrganizerApiError("request-failed");
  const user = userEvent.setup();
  renderHostedAppAt("/admin", session, api);

  expect(await screen.findByRole("alert")).toHaveTextContent("Reports could not be loaded.");
  await user.click(screen.getByRole("button", { name: "Retry" }));

  expect(await screen.findByText("WG-A1B2C3D4E5F6")).toBeInTheDocument();
  expect(api.listReportsCalls).toBe(2);
});

test("signs out after an expired organizer session", async () => {
  const session = new FakeOrganizerSession();
  session.token = "expired-token";
  const api = new FakeOrganizerApi();
  api.reportError = new OrganizerApiError("unauthorized");
  renderHostedAppAt("/admin", session, api);

  expect(await screen.findByRole("heading", { name: "Organizer sign in" })).toBeInTheDocument();
  expect(session.signOutCalls).toBe(1);
});
