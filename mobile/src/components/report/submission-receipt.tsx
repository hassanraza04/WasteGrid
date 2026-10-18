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
    <AppText tone="muted">Report history requires logging in and explicitly importing reports saved on this device.</AppText>
    <Button label="View report history" variant="outline" onPress={onHistory} />
    <Button label="Done" onPress={onDone} />
  </Screen>;
}
