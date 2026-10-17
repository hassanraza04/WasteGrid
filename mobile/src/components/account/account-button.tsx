import { router } from "expo-router";

import { Avatar, IconButton, PressableScale } from "@/components/ui";
import { useSession } from "@/auth/session";
import { Sizes } from "@/theme";

type Props = {
  floating?: boolean; // over the map: white with a shadow
};

// Top-corner avatar on every tab. Signed out it opens Log in; signed in it opens the account sheet.
export function AccountButton({ floating }: Props) {
  const session = useSession();

  if (!session) {
    return (
      <IconButton
        icon="log-in"
        variant={floating ? "floating" : "surface"}
        accessibilityLabel="Log in"
        onPress={() => router.push("/login")}
      />
    );
  }

  return (
    <PressableScale onPress={() => router.push("/account")} accessibilityRole="button" accessibilityLabel={`Account, signed in as ${session.email}`}>
      <Avatar name={session.email} size={Sizes.iconButton} />
    </PressableScale>
  );
}
