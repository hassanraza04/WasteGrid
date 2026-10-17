import { useState } from "react";

import { useLocalCity } from "@/hooks/use-local-city";
import type { City } from "@/data/cities";

// The city a screen is showing: the user's own city until they search for another one
export function useCityPicker() {
  const local = useLocalCity();
  const localCity = local.status === "found" ? local.city : null;
  const [searchedCity, setSearchedCity] = useState<City | null>(null);

  const city = searchedCity ?? localCity;
  return {
    local, // how locating the user went, for the "no city" message
    city,
    isLocal: !!city && city.id === localCity?.id,
    canGoBackToLocal: !!localCity && city?.id !== localCity.id,
    selectCity: setSearchedCity,
    backToLocal: () => setSearchedCity(null),
  };
}
