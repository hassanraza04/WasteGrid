import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { OrganizerRouteMap } from "./OrganizerRouteMap";
import { routePreview } from "../test/routingFixtures";
import type { OrganizerApi } from "./organizerApi";
const leaflet = vi.hoisted(() => {
  const map = { setView: vi.fn().mockReturnThis(), fitBounds: vi.fn(), remove: vi.fn() };
  const layer = { addTo: vi.fn().mockReturnThis() };
  const bounds = { extend: vi.fn(), isValid: vi.fn().mockReturnValue(true) };
  return { map, layer, bounds, createMap: vi.fn(() => map), tileLayer: vi.fn(() => layer), polyline: vi.fn(() => layer), latLng: vi.fn((lat, lng) => ({ lat, lng })), latLngBounds: vi.fn(() => bounds) };
});
vi.mock("leaflet", () => ({ default: { map: leaflet.createMap, tileLayer: leaflet.tileLayer, polyline: leaflet.polyline, latLng: leaflet.latLng, latLngBounds: leaflet.latLngBounds } }));
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
const geometry = { status: "ready", geometry: { type: "LineString", coordinates: [[67.1, 24.9], [67.11, 24.91]] }, retry_after_seconds: null };
function api() { return { sessionVersion: 1, geometry: vi.fn().mockResolvedValue(geometry) } as unknown as OrganizerApi; }
test("draws actual provider roads with OSM attribution and cleans up", async () => {
  const client = api(); const view = render(<OrganizerRouteMap api={client} preview={routePreview()} />);
  expect(await screen.findByText(/1 road route displayed/)).toHaveTextContent("no live traffic");
  expect(client.geometry).toHaveBeenCalledWith("preview-1", "crew-1"); expect(leaflet.latLng).toHaveBeenCalledWith(24.9, 67.1);
  expect(leaflet.polyline).toHaveBeenCalledTimes(1);
  expect(leaflet.tileLayer).toHaveBeenCalledWith("https://tile.openstreetmap.org/{z}/{x}/{y}.png", expect.objectContaining({ attribution: expect.stringContaining("OpenStreetMap") }));
  expect(leaflet.map.fitBounds).toHaveBeenCalled(); view.unmount(); expect(leaflet.map.remove).toHaveBeenCalled();
});
test.each(["rejection", "rate_limited"])("%s shows unavailable geometry without fake lines", async failure => {
  const client = api(); if (failure === "rejection") vi.mocked(client.geometry).mockRejectedValue(new Error("provider down"));
  else { vi.useFakeTimers(); vi.mocked(client.geometry).mockResolvedValue({ status: "rate_limited", geometry: null, retry_after_seconds: 2 }); }
  render(<OrganizerRouteMap api={client} preview={routePreview()} />);
  if (failure === "rate_limited") {
    await act(async () => { await Promise.resolve(); });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText(/1 unavailable; approved estimates unchanged/)).toBeInTheDocument();
    expect(client.geometry).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(client.geometry).toHaveBeenCalledTimes(3);
  } else expect(await screen.findByText(/1 unavailable; approved estimates unchanged/)).toBeInTheDocument();
  expect(leaflet.polyline).not.toHaveBeenCalled();
});
test("skips crews without stops", async () => {
  const client = api(), preview = routePreview(); preview.routes[0].stops = [];
  render(<OrganizerRouteMap api={client} preview={preview} />);
  expect(await screen.findByText("No route geometry for this preview.")).toBeInTheDocument(); expect(client.geometry).not.toHaveBeenCalled();
});
test("requests sequentially with a provider pause", async () => {
  vi.useFakeTimers(); const client = api(), preview = routePreview(); preview.routes.push({ ...preview.routes[0], crew_id: "crew-2" });
  render(<OrganizerRouteMap api={client} preview={preview} />);
  await act(async () => { await Promise.resolve(); }); expect(client.geometry).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1099)); expect(client.geometry).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(client.geometry).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/2 road routes displayed/)).toBeInTheDocument();
});
test.each(["unmount", "account"])("ignores late provider data after %s", async trigger => {
  const client = api(); let finish!: (value: typeof geometry) => void;
  vi.mocked(client.geometry).mockReturnValueOnce(new Promise(resolve => { finish = resolve as never; }));
  const view = render(<OrganizerRouteMap api={client} preview={routePreview()} />);
  await waitFor(() => expect(client.geometry).toHaveBeenCalled());
  if (trigger === "unmount") view.unmount(); else Object.assign(client, { sessionVersion: 2 });
  await act(async () => finish(geometry)); expect(leaflet.polyline).not.toHaveBeenCalled();
});


test("a transient shared provider cooldown retries before displaying its actual road", async () => {
  vi.useFakeTimers(); const client = api();
  vi.mocked(client.geometry).mockResolvedValueOnce({ status: "rate_limited", geometry: null, retry_after_seconds: null });
  render(<OrganizerRouteMap api={client} preview={routePreview()} />);
  await act(async () => { await Promise.resolve(); });
  expect(client.geometry).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1099)); expect(client.geometry).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(1)); expect(client.geometry).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/1 road route displayed/)).toBeInTheDocument();
});
test("React StrictMode shares the in-flight request across effect replay", async () => {
  const client = api();
  render(<StrictMode><OrganizerRouteMap api={client} preview={routePreview()} /></StrictMode>);
  expect(await screen.findByText(/1 road route displayed/)).toBeInTheDocument();
  expect(client.geometry).toHaveBeenCalledTimes(1); expect(leaflet.polyline).toHaveBeenCalledTimes(1);
  expect(leaflet.createMap).toHaveBeenCalledTimes(2);
});
test("navigation cancels a scheduled cooldown retry", async () => {
  vi.useFakeTimers(); const client = api();
  vi.mocked(client.geometry).mockResolvedValue({ status: "rate_limited", geometry: null, retry_after_seconds: 100 });
  const view = render(<OrganizerRouteMap api={client} preview={routePreview()} />);
  await act(async () => { await Promise.resolve(); }); view.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(client.geometry).toHaveBeenCalledTimes(1); expect(leaflet.polyline).not.toHaveBeenCalled();
});
