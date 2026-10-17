import { useEffect, useState } from "react";

import { getCityAssignments, getCrewAssignment, onAssignmentsChanged, type Assignment } from "@/data/assignments";

// A crew's current route; refetches whenever assignments change. `undefined` while the first load is in flight.
export function useCrewAssignment(crewId: string | undefined): Assignment | null | undefined {
  const [result, setResult] = useState<{ crewId: string; assignment: Assignment | null } | null>(null);

  useEffect(() => {
    if (!crewId) return;
    let cancelled = false;
    const load = () => getCrewAssignment(crewId).then((assignment) => {
      if (!cancelled) setResult({ crewId, assignment });
    });
    load();
    const unsubscribe = onAssignmentsChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [crewId]);

  if (!crewId) return null;
  return result?.crewId === crewId ? result.assignment : undefined;
}

// Every crew's current route in a city; refetches whenever assignments change
export function useCityAssignments(cityId: string | undefined): Assignment[] {
  const [result, setResult] = useState<{ cityId: string; assignments: Assignment[] } | null>(null);

  useEffect(() => {
    if (!cityId) return;
    let cancelled = false;
    const load = () => getCityAssignments(cityId).then((assignments) => {
      if (!cancelled) setResult({ cityId, assignments });
    });
    load();
    const unsubscribe = onAssignmentsChanged(load);
    return () => { cancelled = true; unsubscribe(); };
  }, [cityId]);

  if (!cityId || !result || result.cityId !== cityId) return [];
  return result.assignments;
}
