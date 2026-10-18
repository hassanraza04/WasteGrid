import { useMemo } from "react";
import { WebView } from "react-native-webview";
import type { Coords } from "@/utils/location";
import { pinMapHtml, readMapMessage } from "./pin-map-html";

export type PinMapProps = { center: Coords; onPin: (coords: Coords) => void; onReady: () => void; onError: () => void };
export function PinMap({ center, onPin, onReady, onError }: PinMapProps) {
  const html = useMemo(() => pinMapHtml(center), [center]);
  return <WebView source={{ html }} originWhitelist={["*"]}
    applicationNameForUserAgent="WasteGrid/1.0 (+https://github.com/hassanraza04/WasteGrid)"
    cacheEnabled javaScriptEnabled domStorageEnabled={false}
    onShouldStartLoadWithRequest={request => request.url === "about:blank"}
    onError={onError} onHttpError={onError}
    onMessage={event => {
      const value = readMapMessage(event.nativeEvent.data);
      if (value === "ready") onReady();
      else if (value === "error") onError();
      else if (value) onPin(value);
    }} />;
}
