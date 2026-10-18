import { useEffect, useRef, useState } from "react";
import { AppText, Button, Card } from "@/components/ui";
import { discardRejectedStaff, reconcileDispatchConflict, submitStaff } from "@/services/pending-staff";
import type { StaffCommand } from "@/services/staff-commands";

export function PendingActions({ commands, refresh }: { commands: StaffCommand[]; refresh(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (command: StaffCommand, discard = false) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try {
      if (command.kind === "dispatch" && command.recomputeRequired) await reconcileDispatchConflict(command);
      else await (discard ? discardRejectedStaff(command) : submitStaff(command));
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "Unable to recover this saved action.");
    } finally {
      if (mounted.current) {
        try { await refresh(); }
        catch { if (mounted.current) setError("Unable to refresh current routing state. Keep the saved action and retry."); }
        if (mounted.current) setBusy(false);
      }
      working.current = false;
    }
  };
  return <>
    {commands.map(command => {
      const recompute = command.kind === "dispatch" && command.recomputeRequired;
      const unknownDispatch = command.kind === "dispatch" && command.dispatchAttemptPending && !recompute;
      return <Card key={command.command_id}>
        <AppText variant="headline">Saved {command.kind} action</AppText>
        <AppText selectable>{command.resource_id}</AppText>
        <AppText tone="muted">{recompute
          ? "This proposal needs a new routing review. Refresh routing state before computing another preview. Another organiser may already have dispatched it."
          : unknownDispatch ? "The dispatch result is unknown. Check its saved result without sending it again. New routing remains blocked until the outcome is confirmed."
          : command.rejected ? "The server rejected this action. Recover or discard it before submitting corrected details." : "Confirmation pending. Retry preserves the original command and evidence."}</AppText>
        <Button label={recompute ? "Refresh routing state" : unknownDispatch ? "Check dispatch result" : `Recover ${command.kind}`} disabled={busy} onPress={() => { void run(command); }} />
        {!recompute && !unknownDispatch && command.rejected && <Button label="Discard rejected action" variant="outline" disabled={busy} onPress={() => { void run(command, true); }} />}
      </Card>;
    })}
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
  </>;
}
