import { useSession } from "@/auth/session";
import { LiveCrewRoute } from "@/components/route/live-crew-route";
import { AppText, Screen } from "@/components/ui";

export default function MyRoute() {
  const session = useSession();
  return session?.role === "crew" && session.crewId ? <LiveCrewRoute key={`${session.userId}:${session.crewId}`} />
    : <Screen><AppText>Sign in with a linked crew account to see your route.</AppText></Screen>;
}
