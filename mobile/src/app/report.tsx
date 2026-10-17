// app/report.tsx — New report: take a photo, then add location + caption
import { useState } from "react";
import { router } from "expo-router";

import { CameraStep } from "@/components/report/camera-step";
import { ReportForm } from "@/components/report/report-form";
import { getPhotoLocation, type PhotoLocation } from "@/utils/location";

export default function Report() {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [location, setLocation] = useState<PhotoLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [caption, setCaption] = useState("");

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

  const canSubmit = caption.trim().length > 0 && !!(location?.coords || location?.address.trim());

  const onSubmit = () => {
    const report = { photoUri, caption: caption.trim(), location };
    // TODO: upload once the report API exists (see web/src/domain/reports.ts for the shared shape)
    console.log("New report", report);
    router.back();
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
      onRetake={() => setPhotoUri(null)} // keeps caption + location
      onSubmit={onSubmit}
      onClose={() => router.back()}
    />
  );
}
