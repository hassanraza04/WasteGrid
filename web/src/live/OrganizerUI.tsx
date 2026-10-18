import { useEffect, useRef, type ReactNode } from "react";

export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "red";
}) {
  return <span className={`wg-chip wg-${tone}`}>{children}</span>;
}
export function Alert({ children }: { children: ReactNode }) {
  return (
    <div className="wg-alert" role="alert">
      {children}
    </div>
  );
}
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="wg-empty">
      <span className="wg-empty-mark" aria-hidden="true">
        ◎
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
export function LoadingState({
  label = "Loading operational data…",
}: {
  label?: string;
}) {
  return (
    <div role="status" className="wg-loading">
      <p>{label}</p>
      <div className="wg-skeleton" />
      <div className="wg-skeleton wg-short" />
    </div>
  );
}
export function FieldValue({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean | null;
}) {
  return (
    <p className="wg-field-value">
      <strong>{label}:</strong>{" "}
      <span>
        {value === null || value === "" ? "Not recorded" : String(value)}
      </span>
    </p>
  );
}
export function useForegroundRefresh(refresh: () => void, enabled = true) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    const update = () => {
      if (document.visibilityState === "visible") callback.current();
    };
    const interval = window.setInterval(update, 15_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled]);
}
export function Dialog({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = container.current!;
    const focusable = () =>
      Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
        ),
      );
    (focusable()[0] ?? node).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) close.current();
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0] ?? node;
      const last = items.at(-1) ?? node;
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === node)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !items.length)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    node.addEventListener("keydown", trap);
    return () => {
      node.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [busy]);
  return (
    <div className="wg-dialog-backdrop">
      <div
        ref={container}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="wg-dialog"
      >
        <div className="wg-section-heading">
          <h3>{title}</h3>
          <button
            className="wg-button wg-secondary"
            disabled={busy}
            onClick={onClose}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
export function formatDate(value: string) {
  return new Date(value).toLocaleString();
}
