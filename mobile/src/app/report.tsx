import { useEffect, useRef, useState } from "react";
import { router } from "expo-router";

import { createDraft, discardDraft, sendDraft } from "@/services/reports";
import { reportFields, ReportRejectedError, type ReportDraft } from "@/services/report-client";
import { CameraStep } from "@/components/report/camera-step";
import { ReportForm } from "@/components/report/report-form";
import { describePhoto } from "@/utils/describe-photo";
import { getPhotoLocation, type PhotoLocation } from "@/utils/location";

export default function Report() {
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [location, setLocation] = useState<PhotoLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [caption, setCaption] = useState("");
  const [describing, setDescribing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ReportDraft | null>(null);
  const submitting = useRef(false);
  const locationRequest = useRef(0);
  const photoRevision = useRef(0);
  useEffect(() => () => { locationRequest.current++; photoRevision.current++; }, []);

  const locate = async (keepTyped: boolean) => {
    const revision = ++locationRequest.current;
    setLocating(true);
    setLocationError("");
    const result = await getPhotoLocation();
    if (revision !== locationRequest.current) return;
    setLocating(false);
    if (result) setLocation(prev => keepTyped && prev?.address ? { ...result, address: prev.address } : result);
    else setLocationError("Your location is unavailable. Retry GPS or choose and confirm a map pin.");
  };

  const onCapture = (uri: string) => {
    photoRevision.current++;
    setPhotoUri(uri);
    void locate(true);
  };

  const generateCaption = async () => {
    if (!photoUri) return;
    const revision = photoRevision.current;
    setDescribing(true);
    try {
      const description = await describePhoto(photoUri);
      if (revision === photoRevision.current) {
        if (description) setCaption(description);
        else setError("Photo descriptions are not connected yet. Please enter a caption.");
      }
    } catch { setError("Unable to describe this photo. Please enter a caption."); }
    finally { setDescribing(false); }
  };

  let fields: Record<string, string> | undefined;
  try { fields = reportFields(caption, location); } catch { /* Form is incomplete. */ }
  const canSubmit = !busy && !describing && !draft?.rejection && (!!draft || !!fields);

  const onSubmit = async () => {
    if (submitting.current || !photoUri || !canSubmit) return;
    submitting.current = true; setBusy(true); setError("");
    // A GPS response must not change the visible form after its immutable draft is saved.
    locationRequest.current++; setLocating(false);
    try {
      const saved = draft ?? await createDraft(photoUri, fields!);
      setDraft(saved);
      await sendDraft(saved);
      router.replace("/(tabs)/reports");
    } catch (error) {
      if (error instanceof ReportRejectedError) setDraft(value => value ? { ...value, rejection: error.message } : value);
      setError(error instanceof Error ? error.message : "Unable to confirm this upload. Keep the saved draft and retry.");
    } finally { submitting.current = false; setBusy(false); }
  };

  const editRejected = async () => {
    if (!draft?.rejection || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    try {
      await discardDraft(draft);
      setDraft(null); // The next submission gets a fresh identity; photo/caption remain editable.
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to discard this rejected upload."); }
    finally { submitting.current = false; setBusy(false); }
  };

  if (!photoUri) return <CameraStep onCapture={onCapture} onClose={() => router.back()} />;

  return <ReportForm
    photoUri={photoUri} location={location} locating={locating} locationError={locationError}
    onAddressChange={address => setLocation(prev => ({ coords: prev?.coords ?? null, address }))}
    onRelocate={() => void locate(false)} caption={caption} onCaptionChange={setCaption}
    onConfirmPin={coords => {
      locationRequest.current++; setLocating(false); setLocationError("");
      setLocation(prev => ({ coords, address: prev?.address ?? "" }));
    }}
    describing={describing} onGenerateCaption={generateCaption}
    canSubmit={canSubmit} busy={busy} frozen={busy || !!draft} error={error}
    onEditRejected={draft?.rejection ? editRejected : undefined}
    onRetake={() => { photoRevision.current++; locationRequest.current++; setPhotoUri(null); setLocation(null); setLocating(false); setLocationError(""); setError(""); }}
    onSubmit={onSubmit} onClose={() => router.back()}
  />;
}
