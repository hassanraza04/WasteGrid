import { expect, test } from "vitest";

import { ConfigurationError, readHostedDashboardConfig } from "./hostedDashboard";

test("reads the three required public dashboard settings", () => {
  expect(
    readHostedDashboardConfig({
      VITE_API_BASE_URL: "https://api.example.test/",
      VITE_SUPABASE_URL: "https://project.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    }),
  ).toEqual({
    apiBaseUrl: "https://api.example.test",
    supabaseUrl: "https://project.supabase.co",
    supabasePublishableKey: "sb_publishable_test",
  });
});

test("rejects a missing public dashboard setting", () => {
  expect(() =>
    readHostedDashboardConfig({
      VITE_API_BASE_URL: "https://api.example.test",
      VITE_SUPABASE_URL: "",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    }),
  ).toThrow(ConfigurationError);
});
