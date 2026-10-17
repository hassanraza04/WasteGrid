import { expect, test, vi } from "vitest";

import { HostedOrganizerApi } from "./organizerApi";

test("uses the bearer token for identity and reports", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ role: "organizer" }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            id: "report-id",
            public_reference: "WG-A1B2C3D4E5F6",
            title: "Overflowing bin",
            dashboard_status: "submitted",
            address: null,
          },
        ]),
        { status: 200 },
      ),
    );
  const api = new HostedOrganizerApi("https://api.example.test", fetcher);

  await expect(api.getIdentity("access-token")).resolves.toEqual({ role: "organizer" });
  await expect(api.listReports("access-token")).resolves.toMatchObject([
    { publicReference: "WG-A1B2C3D4E5F6", dashboardStatus: "submitted" },
  ]);
  expect(fetcher).toHaveBeenNthCalledWith(1, "https://api.example.test/auth/me", {
    headers: { Authorization: "Bearer access-token" },
  });
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    "https://api.example.test/organizer/reports",
    { headers: { Authorization: "Bearer access-token" } },
  );
});

test("labels a 401 response as unauthorized", async () => {
  const api = new HostedOrganizerApi(
    "https://api.example.test",
    vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
  );

  await expect(api.getIdentity("expired-token")).rejects.toMatchObject({
    kind: "unauthorized",
  });
});
