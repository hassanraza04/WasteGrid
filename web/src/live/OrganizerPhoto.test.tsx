import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";

import { OrganizerPhoto } from "./OrganizerPhoto";
import { AccessError, type OrganizerApi } from "./organizerApi";

test("expires the organiser session when private photo access is rejected", async () => {
  const onSessionExpired = vi.fn();
  const api = { photo: vi.fn().mockRejectedValue(new AccessError("Your session expired or access was denied. Please sign in again.")) } as unknown as OrganizerApi;
  render(<OrganizerPhoto api={api} id="photo-1" width={240} onSessionExpired={onSessionExpired} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Load photo" }));
  expect(onSessionExpired).toHaveBeenCalledWith(expect.any(AccessError));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
