import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { expect, test, vi } from "vitest";

import { App } from "./App";
import { BrowserReportRepository, ReportStorageError } from "../data/browserReportRepository";

function throwStorageError(): string | undefined {
  throw new ReportStorageError();
}

test("shows a retry action when report storage fails", async () => {
  const repository = new BrowserReportRepository(window.localStorage);
  const user = userEvent.setup();
  const rememberedReference = vi
    .spyOn(repository, "getRememberedReference")
    .mockImplementation(throwStorageError);

  render(
    <MemoryRouter>
      <App repository={repository} />
    </MemoryRouter>,
  );

  expect(screen.getByRole("alert")).toHaveTextContent("We could not load report information.");

  rememberedReference.mockRestore();
  await user.click(screen.getByRole("button", { name: "Try again" }));

  expect(screen.getByRole("heading", { name: "WasteGrid" })).toBeInTheDocument();
});
