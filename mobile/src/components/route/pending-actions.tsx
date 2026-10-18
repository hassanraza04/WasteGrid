import { useRef, useState } from "react";
import { AppText, Button, Card } from "@/components/ui";
import { discardRejectedStaff, submitStaff } from "@/services/pending-staff";
import type { StaffCommand } from "@/services/staff-commands";

export function PendingActions({ commands, refresh }: { commands: StaffCommand[]; refresh(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const working = useRef(false);
  const run = async (command: StaffCommand, discard = false) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await (discard ? discardRejectedStaff(command) : submitStaff(command)); }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to recover this saved action."); }
    finally { await refresh(); working.current = false; setBusy(false); }
  };
  return <>
    {commands.map(command => <Card key={command.command_id}>
      <AppText variant="headline">Saved {command.kind} action</AppText>
      <AppText selectable>{command.resource_id}</AppText>
      <AppText tone="muted">{command.rejected ? "The server rejected this action. Recover or discard it before submitting corrected details." : "Confirmation pending. Retry preserves the original command and evidence."}</AppText>
      <Button label={`Recover ${command.kind}`} disabled={busy} onPress={() => { void run(command); }} />
      {command.rejected && <Button label="Discard rejected action" variant="outline" disabled={busy} onPress={() => { void run(command, true); }} />}
    </Card>)}
    {error ? <AppText accessibilityRole="alert">{error}</AppText> : null}
  </>;
}
