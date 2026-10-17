// areas.ts — cities and the areas inside them that stats and routes are grouped by
// TODO: load from the API once areas are defined server-side

export type Area = {
  id: string;
  name: string;
  city: string;
  cityWide?: boolean; // covers every area in the city
};

export const AREAS: Area[] = [
  { id: "karachi", name: "All of Karachi", city: "Karachi", cityWide: true },
  { id: "dha", name: "DHA", city: "Karachi" },
  { id: "clifton", name: "Clifton", city: "Karachi" },
  { id: "saddar", name: "Saddar", city: "Karachi" },
];

// True if something in `areaId` belongs under the selected area (a city-wide area includes all of them)
export function isInArea(areaId: string, selected: Area): boolean {
  return selected.cityWide || areaId === selected.id;
}
