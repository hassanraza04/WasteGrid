import { AccountButton } from "@/components/account/account-button";
import { AppText, Card, Screen, ScreenHeader } from "@/components/ui";

// The native Explore screen uses react-native-maps, which cannot run in Expo Web.
export default function ExploreWeb() {
  return <Screen>
    <ScreenHeader title="Explore" trailing={<AccountButton />} />
    <Card>
      <AppText variant="headline">Explore on your phone</AppText>
      <AppText tone="muted">Open the Android or iOS app to view waste locations and submit a photo report.</AppText>
    </Card>
  </Screen>;
}
