import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";
import { useFocusEffect } from "expo-router";
import * as Location from "expo-location";
import { getSession, useSession } from "@/auth/session";
import { staffApi } from "@/services/staff";

export function useCrewLocation() {
  const session = useSession();
  const [result, setResult] = useState<{ owner: typeof session; message: string } | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const inFlight = useRef(false);
  useFocusEffect(useCallback(() => {
    let active = true;
    const publish = async () => {
      if (!active || inFlight.current || session?.role !== "crew" || AppState.currentState !== "active") return;
      inFlight.current = true;
      const show = (message: string) => { if (active && getSession() === session) setResult({ owner: session, message }); };
      let timer: ReturnType<typeof setTimeout> | undefined;
      let observationRequest: Promise<Location.LocationObject> | undefined;
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") { show("Allow foreground location so your crew can be routed."); return; }
        if (!active || AppState.currentState !== "active" || getSession() !== session) return;
        observationRequest = Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        const observation = await Promise.race([
          observationRequest,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("GPS timed out. Try outdoors and refresh.")), 15000); }),
        ]);
        if (!active || AppState.currentState !== "active" || getSession() !== session) return;
        await staffApi.location({ latitude: observation.coords.latitude, longitude: observation.coords.longitude }, new Date(observation.timestamp).toISOString());
        show(`Location shared at ${new Date(observation.timestamp).toLocaleTimeString()}`);
      } catch (error) { show(error instanceof Error ? error.message : "Unable to share location."); }
      finally {
        clearTimeout(timer);
        // Native GPS is not cancelled by Promise.race. Keep ownership until it
        // settles; a timed-out fix is never published or replaced concurrently.
        if (observationRequest) await observationRequest.catch(() => {});
        inFlight.current = false;
      }
    };
    refresh.current = publish;
    void publish();
    const interval = setInterval(() => { void publish(); }, 30000);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void publish(); });
    return () => { active = false; clearInterval(interval); subscription.remove(); };
  }, [session]));
  return { message: result?.owner === session ? result.message : "Sharing foreground crew location…", refresh: () => refresh.current() };
}
