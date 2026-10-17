// crews.ts — cleanup crews and where they are. Demo data for now.
// TODO: live crew locations from the API
import { isInArea, type Area } from "@/data/areas";
import type { Coords } from "@/utils/location";

export type Crew = {
  id: string;
  name: string;
  areaId: string;
  coords: Coords; // last known position: where the crew's route starts
  onDuty: boolean;
};

const DEMO_CREWS: Crew[] = [
  { id: "crew-a", name: "Crew A", areaId: "dha", coords: { latitude: 24.8091, longitude: 67.0402 }, onDuty: true },
  { id: "crew-b", name: "Crew B", areaId: "dha", coords: { latitude: 24.7987, longitude: 67.0611 }, onDuty: false },
  { id: "crew-c", name: "Crew C", areaId: "clifton", coords: { latitude: 24.8205, longitude: 67.0289 }, onDuty: true },
  { id: "crew-d", name: "Crew D", areaId: "saddar", coords: { latitude: 24.8566, longitude: 67.0262 }, onDuty: true },
];

export function getCrews(area: Area): Crew[] {
  return DEMO_CREWS.filter((crew) => isInArea(crew.areaId, area));
}
