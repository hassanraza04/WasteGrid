// app/report.tsx — New report: take a photo, then add location + caption
import { useRef, useState } from "react";
import { Alert } from "react-native";
import { router } from "expo-router";

import { createDraft, sendDraft } from "@/services/reports";
import type { ReportDraft } from "@/services/report-client";
import { CameraStep } from "@/components/report/camera-step";
import { ReportForm } from "@/components/report/report-form";
import { getPhotoLocation, type PhotoLocation } from "@/utils/location";

export default function Report() {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [location, setLocation] = useState<PhotoLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [caption, setCaption] = useState("");

  const [fire, setFire] = useState<boolean | null>(null);
  const [sharp, setSharp] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const submitting = useRef(false);

  // keepTyped: the automatic lookup after capture shouldn't overwrite an address the user already typed
  const locate = async (keepTyped: boolean) => {
    setLocating(true);
    const result = await getPhotoLocation();
    setLocating(false);
    if (!result) return; // denied/unavailable → user types the address
    setLocation((prev) => (keepTyped && prev?.address ? { ...result, address: prev.address } : result));
  };

  const onCapture = (uri: string) => {
    setPhotoUri(uri);
    locate(true); // resolves while the user writes the caption
  };

  const canSubmit = !busy && (draft !== null || (caption.trim().length > 0 && !!location?.coords && fire !== null && sharp !== null));

  const onSubmit = async () => {
    if (submitting.current || !photoUri || !canSubmit) return;
    submitting.current = true; setBusy(true);
    try {
      const saved = draft ?? await createDraft(photoUri, {
        title: caption.trim().slice(0, 160), note: caption.trim(),
        ...(location?.address.trim() ? { address: location.address.trim() } : {}),
        latitude: String(location!.coords!.latitude), longitude: String(location!.coords!.longitude),
        resident_fire: String(fire), resident_sharp_objects: String(sharp),
      });
      setDraft(saved);
      await sendDraft(saved);
      router.replace("/my-reports");
    } catch (error) {
      Alert.alert("Report not confirmed", (error instanceof Error ? error.message : "Please retry shortly.") + " Saved uploads can be retried from My reports.");
    } finally { submitting.current = false; setBusy(false); }
  };

  if (!photoUri) {
    return <CameraStep onCapture={onCapture} onClose={() => router.back()} />;
  }

  return (
    <ReportForm
      photoUri={photoUri}
      location={location}
      locating={locating}
      onAddressChange={(address) => setLocation((prev) => ({ coords: prev?.coords ?? null, address }))}
      onRelocate={() => locate(false)}
      caption={caption}
      onCaptionChange={setCaption}
      canSubmit={canSubmit}
      busy={busy}
      frozen={busy || !!draft}
      fire={fire} onFireChange={setFire}
      sharp={sharp} onSharpChange={setSharp}
      onRetake={() => setPhotoUri(null)} // keeps caption + location
      onSubmit={onSubmit}
      onClose={() => router.back()}
    />
  );
}
