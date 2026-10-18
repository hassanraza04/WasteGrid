import { useEffect, useRef, useState } from "react";

import { AccessError, type OrganizerApi } from "./organizerApi";

export function OrganizerPhoto({ api, id, width, onSessionExpired }: { api: OrganizerApi; id: string; width: number; onSessionExpired?: (error: AccessError) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => () => { generation.current++; }, []);

  async function load() {
    const request = ++generation.current;
    setBusy(true); setError("");
    try {
      const nextUrl = await api.photo(id);
      if (request === generation.current) setUrl(nextUrl);
    } catch (caught) {
      if (request === generation.current) {
        if (caught instanceof AccessError) { onSessionExpired?.(caught); return; }
        setError("Photo unavailable. Try loading it again.");
      }
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }

  return <div>
    <button disabled={busy} onClick={() => void load()}>Load photo</button>
    {url && <img src={url} alt="Reported waste" width={width} onError={() => { setUrl(""); setError("Photo link expired. Load it again."); }} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}
