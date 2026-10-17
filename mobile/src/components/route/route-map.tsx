import { useEffect, useRef, useState } from "react";
import { View, StyleSheet } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from "react-native-maps";
import mapStyle from "@/theme/mapStyle.json";

import { StopMarker } from "@/components/route/stop-marker";
import { Colors, Radius, Shadow } from "@/theme";
import { DEFAULT_REGION, regionAround } from "@/utils/map";
import type { AssignedStop } from "@/data/assignments";

const EDGE = { top: 48, right: 48, bottom: 48, left: 48 };

// Fixed preview of a route: the line through every stop, with numbered markers
export function RouteMap({ stops }: { stops: AssignedStop[] }) {
  const mapRef = useRef<MapView>(null);
  const coords = stops.map((stop) => stop.coords);
  const [ready, setReady] = useState(false);
  const coordinatesKey = JSON.stringify(coords);
  useEffect(() => {
    const points = JSON.parse(coordinatesKey);
    if (ready && points.length) mapRef.current?.fitToCoordinates(points, { edgePadding: EDGE, animated: false });
  }, [ready, coordinatesKey]);

  return (
    <View style={s.frame}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        customMapStyle={mapStyle}
        initialRegion={coords.length ? regionAround(coords[0], 0.05) : DEFAULT_REGION}
        onMapReady={() => setReady(true)}
        // Static so it doesn't fight the page's scrolling
        scrollEnabled={false}
        zoomEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}>
        <Polyline coordinates={coords} strokeColor={Colors.ink} strokeWidth={4} />
        {stops.map((stop, i) => (
          <Marker key={`${stop.reportId}-${!!stop.cleanedAt}`} coordinate={stop.coords} anchor={{ x: 0.5, y: 0.5 }}>
            <StopMarker index={i} cleaned={!!stop.cleanedAt} />
          </Marker>
        ))}
      </MapView>
    </View>
  );
}

const s = StyleSheet.create({
  frame: { height: 220, borderRadius: Radius.lg, overflow: "hidden", backgroundColor: Colors.surfaceSunken, ...Shadow.card },
});
