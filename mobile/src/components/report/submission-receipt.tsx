import { AppText, Button, Card, Screen, ScreenHeader } from "@/components/ui";

type Props = {
  reference: string;
  onHistory: () => void;
  onDone: () => void;
};

export function SubmissionReceipt({ reference, onHistory, onDone }: Props) {
  return <Screen tabBar={false} edges={["top", "bottom"]}>
    <ScreenHeader title="Report received" subtitle="WasteGrid accepted your report." />
    <Card>
      <AppText>Your report reference</AppText>
      <AppText variant="headline" selectable>{reference}</AppText>
      <AppText tone="muted">Touch and hold the reference to copy it.</AppText>
    </Card>
    <AppText tone="muted">View history on this device with the account that submitted the report. If you submitted before logging in, sign in and import this device&apos;s reports.</AppText>
    <Button label="View report history" variant="outline" onPress={onHistory} />
    <Button label="Done" onPress={onDone} />
  </Screen>;
}
