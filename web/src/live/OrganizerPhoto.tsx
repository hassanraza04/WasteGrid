import { useEffect, useRef, useState } from "react";

import { AccessError, type OrganizerApi } from "./organizerApi";

export function OrganizerPhoto({
  api,
  id,
  width,
  onSessionExpired,
}: {
  api: OrganizerApi;
  id: string;
  width: number;
  onSessionExpired?: (error: AccessError) => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const container = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const currentId = useRef(id);
  currentId.current = id;
  async function load() {
    if (inFlight.current) return;
    const request = ++generation.current;
    const session = api.sessionVersion;
    const current = () =>
      request === generation.current &&
      currentId.current === id &&
      session === api.sessionVersion;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const nextUrl = await api.photo(id);
      if (current()) setUrl(nextUrl);
    } catch (caught) {
      if (current()) {
        if (caught instanceof AccessError) onSessionExpired?.(caught);
        else setError("Photo unavailable. Try loading it again.");
      }
    } finally {
      if (request === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    setUrl("");
    setError("");
    setBusy(false);
    inFlight.current = false;
    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined" && container.current) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            void load();
          }
        },
        { rootMargin: "120px" },
      );
      observer.observe(container.current);
    }
    return () => {
      generation.current++;
      observer?.disconnect();
    };
  }, [api, id]);
  return (
    <div
      className="wg-photo"
      ref={container}
      style={{ maxWidth: width < 100 ? width : "100%" }}
    >
      {url ? (
        <img
          src={url}
          alt="Reported waste"
          width={width}
          loading="lazy"
          onError={() => {
            setUrl("");
            setError("Photo link expired. Load it again.");
          }}
        />
      ) : (
        <div className="wg-photo-placeholder" aria-hidden="true">
          <span>{busy ? "Loading photo…" : "Private photo"}</span>
        </div>
      )}
      <button
        className="wg-button wg-secondary"
        disabled={busy}
        onClick={() => void load()}
      >
        Load photo
      </button>
      {error && (
        <p className="wg-alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
