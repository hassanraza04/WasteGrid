import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";

import type { OrganizerApi } from "./organizerApi";

const api = {
  signIn: vi.fn(),
  signOut: vi.fn(),
  reports: vi.fn(),
  photo: vi.fn(),
} as unknown as OrganizerApi;

let storageDescriptor: PropertyDescriptor | undefined;

afterEach(() => {
  if (storageDescriptor) {
    Object.defineProperty(window, "localStorage", storageDescriptor);
    storageDescriptor = undefined;
  }
  vi.resetModules();
  vi.unstubAllEnvs();
});

test.each(["/admin", "/", "/report/new"])("renders %s when browser storage is blocked", async path => {
  storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get: () => {
      throw new DOMException("Storage is blocked", "SecurityError");
    },
  });
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example");
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");

  const { LiveApp } = await import("./LiveApp");
  render(<MemoryRouter initialEntries={[path]}><LiveApp api={api} /></MemoryRouter>);

  expect(screen.getByRole("heading", { name: path === "/admin" ? "Organiser sign in" : "WasteGrid" })).toBeInTheDocument();
});
