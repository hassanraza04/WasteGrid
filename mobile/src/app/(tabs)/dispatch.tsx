// app/(tabs)/dispatch.tsx — Admins only: see each crew's route progress in a city, plan and assign new routes
import { useState } from "react";
import { StyleSheet } from "react-native";

import { AppText, Button, Card, Screen, ScreenHeader } from "@/components/ui";
import { AccountButton } from "@/components/account/account-button";
import { CitySearch } from "@/components/city/city-search";
import { CityHeading } from "@/components/city/city-heading";
import { NoCity } from "@/components/city/no-city";
import { CrewRow } from "@/components/dispatch/crew-row";
import { RoutePlannerOverlay } from "@/components/admin/route-planner-overlay";
import { useCityPicker } from "@/hooks/use-city-picker";
import { useCityAssignments } from "@/hooks/use-assignments";
import { assignRoutes } from "@/data/assignments";
import { getCrews } from "@/data/crews";
import { planCrewRoutes } from "@/utils/route-planner";
import { Spacing } from "@/theme";

export default function Dispatch() {
  const { local, city, isLocal, canGoBackToLocal, selectCity, backToLocal } = useCityPicker();
  const assignments = useCityAssignments(city?.id);
  const [plannerOpen, setPlannerOpen] = useState(false);

  const crews = city ? getCrews(city) : [];

  return (
    <>
      <Screen>
        <ScreenHeader title="Dispatch" trailing={<AccountButton />} />
        <CitySearch onSelect={selectCity} />

        {city ? (
          <>
            <CityHeading city={city} isLocal={isLocal} onBackToLocal={canGoBackToLocal ? backToLocal : undefined} />
            <Button label="Plan routes" icon="navigation" onPress={() => setPlannerOpen(true)} disabled={crews.length === 0} />

            <AppText variant="title" style={s.sectionTitle}>Crews</AppText>
            <Card padding={Spacing.lg} style={s.listCard}>
              {crews.length === 0
                ? <AppText tone="muted" style={s.empty}>No crews in {city.name} yet.</AppText>
                : crews.map((crew, i) => (
                  <CrewRow
                    key={crew.id}
                    crew={crew}
                    assignment={assignments.find((a) => a.crewId === crew.id)}
                    divider={i < crews.length - 1}
                  />
                ))}
            </Card>
          </>
        ) : (
          <NoCity local={local} />
        )}
      </Screen>

      {city && (
        <RoutePlannerOverlay
          key={city.id} // fresh crew selection per city
          visible={plannerOpen}
          city={city}
          crews={crews}
          onClose={() => setPlannerOpen(false)}
          onCalculate={planCrewRoutes}
          onAssign={async (routes) => { await assignRoutes(city.id, routes); }}
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  sectionTitle: { marginTop: Spacing.sm },
  listCard: { paddingVertical: Spacing.xs },
  empty: { paddingVertical: Spacing.md },
});
