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
    let cancelObservation: (() => void) | undefined;
    const publish = async () => {
      if (!active || inFlight.current || session?.role !== "crew" || AppState.currentState !== "active") return;
      inFlight.current = true;
      const show = (message: string) => { if (active && getSession() === session) setResult({ owner: session, message }); };
      try {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") { show("Allow foreground location so your crew can be routed."); return; }
        if (!active || AppState.currentState !== "active" || getSession() !== session) return;
        const observation = await new Promise<Location.LocationObject | null>((resolve, reject) => {
          let watch: Location.LocationSubscription | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let finished = false;
          let complete: (() => void) | undefined;
          const finish = (value: Location.LocationObject | null, error?: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            watch?.remove();
            complete = () => { if (error) reject(error); else resolve(value); };
            if (watch) complete();
          };
          cancelObservation = () => finish(null);
          // The timeout bounds the observation, after the cancellable native
          // subscription is installed. No uncancellable position request remains.
          void Location.watchPositionAsync({ accuracy: Location.Accuracy.High },
            value => finish(value), reason => finish(null, new Error(reason)),
          ).then(subscription => {
            watch = subscription;
            if (finished) { subscription.remove(); complete?.(); return; }
            timer = setTimeout(() => finish(null, new Error("GPS timed out. Try outdoors and refresh.")), 15000);
          }, error => {
            finish(null, error instanceof Error ? error : new Error("Unable to observe GPS."));
            complete?.();
          });
        });
        if (!observation || !active || AppState.currentState !== "active" || getSession() !== session) return;
        await staffApi.location({ latitude: observation.coords.latitude, longitude: observation.coords.longitude }, new Date(observation.timestamp).toISOString());
        show(`Location shared at ${new Date(observation.timestamp).toLocaleTimeString()}`);
      } catch (error) { show(error instanceof Error ? error.message : "Unable to share location."); }
      finally { cancelObservation = undefined; inFlight.current = false; }
    };
    refresh.current = publish;
    void publish();
    const interval = setInterval(() => { void publish(); }, 30000);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void publish(); else cancelObservation?.(); });
    return () => { active = false; cancelObservation?.(); clearInterval(interval); subscription.remove(); };
  }, [session]));
  return { message: result?.owner === session ? result.message : "Sharing foreground crew location…", refresh: () => refresh.current() };
}
