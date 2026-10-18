import { act, fireEvent, render, screen } from "@testing-library/react";
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


test("retries an unavailable photo and renews an expired link without showing its URL as text", async () => {
  const api = { photo: vi.fn().mockRejectedValueOnce(new Error("PRIVATE_STORAGE_RESPONSE")).mockResolvedValueOnce("https://private.example/expired").mockResolvedValueOnce("https://private.example/renewed") } as unknown as OrganizerApi;
  render(<OrganizerPhoto api={api} id="photo-1" width={240} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Load photo" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Photo unavailable");
  expect(screen.queryByText("PRIVATE_STORAGE_RESPONSE")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Load photo" }));
  fireEvent.error(await screen.findByAltText("Reported waste"));
  expect(screen.queryByAltText("Reported waste")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Photo link expired");
  await user.click(screen.getByRole("button", { name: "Load photo" }));
  expect(await screen.findByAltText("Reported waste")).toHaveAttribute("src", "https://private.example/renewed");
  expect(screen.queryByText("https://private.example/renewed")).not.toBeInTheDocument();
});

test.each(["resolve", "reject"])("ignores a late private-photo %s after leaving its report", async outcome => {
  let resolvePhoto!: (url: string) => void;
  let rejectPhoto!: (error: Error) => void;
  const api = { photo: vi.fn().mockReturnValue(new Promise<string>((resolve, reject) => { resolvePhoto = resolve; rejectPhoto = reject; })) } as unknown as OrganizerApi;
  const onSessionExpired = vi.fn();
  const { unmount } = render(<OrganizerPhoto api={api} id="photo-1" width={240} onSessionExpired={onSessionExpired} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Load photo" }));
  expect(screen.getByRole("button", { name: "Load photo" })).toBeDisabled();
  unmount();
  await act(async () => {
    if (outcome === "resolve") resolvePhoto("https://private.example/stale");
    else rejectPhoto(new AccessError("Old session expired"));
  });
  expect(onSessionExpired).not.toHaveBeenCalled();
  expect(screen.queryByAltText("Reported waste")).not.toBeInTheDocument();
});
