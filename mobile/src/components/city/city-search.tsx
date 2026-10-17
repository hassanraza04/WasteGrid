import { useState } from "react";
import { View, Keyboard, StyleSheet } from "react-native";

import { AppText, Card, IconCircle, ListRow, SearchField } from "@/components/ui";
import { useCitySearch } from "@/hooks/use-city-search";
import { Spacing } from "@/theme";
import type { City } from "@/data/cities";

type Props = { onSelect: (city: City) => void };

// Search bar with matching cities listed underneath while typing
export function CitySearch({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const results = useCitySearch(query);
  const searching = query.trim().length > 0;

  const choose = (city: City) => {
    setQuery("");
    Keyboard.dismiss();
    onSelect(city);
  };

  return (
    <View style={s.container}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Search a city"
        autoCapitalize="words"
        onSubmitEditing={() => results[0] && choose(results[0])}
      />
      {searching && (
        <Card padding={Spacing.lg} style={s.results}>
          {results.length === 0 ? (
            <AppText tone="muted" style={s.none}>No stats for &ldquo;{query.trim()}&rdquo; yet.</AppText>
          ) : (
            results.map((city, i) => (
              <ListRow
                key={city.id}
                onPress={() => choose(city)}
                leading={<IconCircle icon="map-pin" />}
                title={city.name}
                subtitle={city.region}
                divider={i < results.length - 1}
              />
            ))
          )}
        </Card>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { gap: Spacing.sm },
  results: { paddingVertical: Spacing.xs },
  none: { paddingVertical: Spacing.md },
});
