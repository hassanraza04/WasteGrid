import { useCallback, useRef, useState } from "react";

// Async work where only the newest call counts. A call superseded by a later run() or by invalidate()
// never delivers its result, so a slow response can't overwrite state built from newer inputs.
export function useLatestRequest() {
  const latest = useRef(0);
  const [pending, setPending] = useState(false);

  // Drop whatever is in flight, e.g. because the inputs it was started with have changed
  const invalidate = useCallback(() => {
    latest.current++;
    setPending(false);
  }, []);

  const run = useCallback(async <T>(work: () => Promise<T>, onResult: (result: T) => void) => {
    const id = ++latest.current;
    setPending(true);
    try {
      const result = await work();
      if (id === latest.current) onResult(result);
    } catch (error) {
      if (id === latest.current) throw error; // a superseded call's failure is no longer relevant
    } finally {
      if (id === latest.current) setPending(false);
    }
  }, []);

  return { run, invalidate, pending };
}
