// app/report.tsx — New report: take a photo, then add location + caption
import { useState } from "react";
import { router } from "expo-router";

import { CameraStep } from "@/components/report/camera-step";
import { ReportForm } from "@/components/report/report-form";
import { getPhotoLocation, type PhotoLocation } from "@/utils/location";

export default function Report() {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [location, setLocation] = useState<PhotoLocation | null>(null);
  const [caption, setCaption] = useState("");

  const onCapture = (uri: string) => {
    setPhotoUri(uri);
    // TODO: kick off getPhotoLocation() here so it resolves while the user types
  };

  const onRetake = () => {
    setPhotoUri(null);
  };

  const onSubmit = () => {
    // TODO: upload { photoUri, location, caption } once there's a backend
    router.back();
  };

  if (!photoUri) {
    return <CameraStep onCapture={onCapture} onClose={() => router.back()} />;
  }

  return (
    <ReportForm
      photoUri={photoUri}
      location={location}
      onLocationChange={setLocation}
      onRelocate={async () => setLocation(await getPhotoLocation())}
      caption={caption}
      onCaptionChange={setCaption}
      onRetake={onRetake}
      onSubmit={onSubmit}
      onClose={() => router.back()}
    />
  );
}
