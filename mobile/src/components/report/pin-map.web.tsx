import { useEffect, useMemo, useRef } from "react";
import type { PinMapProps } from "./pin-map";
import { pinMapHtml, readMapMessage } from "./pin-map-html";

export function PinMap({ center, onPin, onReady, onError }: PinMapProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => pinMapHtml(center), [center]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const value = readMapMessage(event.data);
      if (value === "ready") onReady();
      else if (value === "error") onError();
      else if (value) onPin(value);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onPin, onReady, onError]);
  // srcDoc retains the enclosing site's origin/referrer. Browser HTTP caching
  // follows OSM response headers; tiles are fetched only for the visible map.
  return <iframe ref={frame} title="Choose report location" srcDoc={html} sandbox="allow-scripts allow-same-origin allow-popups"
    referrerPolicy="strict-origin-when-cross-origin" onError={onError} style={{ width: "100%", height: "100%", border: 0 }} />;
}
