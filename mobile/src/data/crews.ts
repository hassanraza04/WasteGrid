// crews.ts — cleanup crews and where they are. Demo data for now.
// TODO: live crew locations from the API
import type { City } from "@/data/cities";
import type { Coords } from "@/utils/location";

export type Crew = {
  id: string;
  name: string;
  cityId: string;
  coords: Coords; // last known position: where the crew's route starts
  onDuty: boolean;
};

const DEMO_CREWS: Crew[] = [
  { id: "crew-a", name: "Crew A", cityId: "karachi", coords: { latitude: 24.8091, longitude: 67.0402 }, onDuty: true },
  { id: "crew-b", name: "Crew B", cityId: "karachi", coords: { latitude: 24.7987, longitude: 67.0611 }, onDuty: false },
  { id: "crew-c", name: "Crew C", cityId: "karachi", coords: { latitude: 24.8205, longitude: 67.0289 }, onDuty: true },
  { id: "crew-d", name: "Crew D", cityId: "karachi", coords: { latitude: 24.8566, longitude: 67.0262 }, onDuty: true },
  { id: "crew-e", name: "Crew E", cityId: "lahore", coords: { latitude: 31.5102, longitude: 74.3441 }, onDuty: true },
  { id: "crew-f", name: "Crew F", cityId: "islamabad", coords: { latitude: 33.7215, longitude: 73.0433 }, onDuty: true },
];

export function getCrews(city: City): Crew[] {
  return DEMO_CREWS.filter((crew) => crew.cityId === city.id);
}

export function getAllCrews(): Crew[] {
  return DEMO_CREWS;
}

export function getCrew(id: string): Crew | undefined {
  return DEMO_CREWS.find((crew) => crew.id === id);
}
