import { Colors } from "@/theme";
import type { Coords } from "@/utils/location";

// Coordinates are the only interpolated data. No report, token, address or caption
// is exposed to the map page or its tile/CDN providers.
export function pinMapHtml(center: Coords): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="">
<style>html,body,#map{width:100%;height:100%;margin:0;background:${Colors.surfaceSunken}}</style></head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=" crossorigin=""></script>
<script>
function send(value){var body=JSON.stringify(value);if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(body)}else{window.parent.postMessage(body,'*')}}
try {
 var map=L.map('map').setView([${center.latitude},${center.longitude}],14), marker, loaded=false;
 L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'})
 .on('tileload',function(){if(!loaded){loaded=true;send({type:'ready'})}}).on('load',function(){if(!loaded)send({type:'error'})}).addTo(map);
 map.on('click',function(event){if(marker)map.removeLayer(marker);marker=L.circleMarker(event.latlng,{radius:9,color:'${Colors.onPrimary}',weight:3,fillColor:'${Colors.primary}',fillOpacity:1}).addTo(map);send({type:'pin',latitude:event.latlng.lat,longitude:event.latlng.lng})});
} catch(error) {send({type:'error'})}
</script></body></html>`;
}

export function readMapMessage(data: unknown): Coords | "ready" | "error" | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data);
    if (value?.type === "ready" || value?.type === "error") return value.type;
    if (value?.type === "pin" && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) &&
        Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180) {
      return { latitude: value.latitude, longitude: value.longitude };
    }
  } catch { /* Ignore unrelated frame messages. */ }
  return null;
}
