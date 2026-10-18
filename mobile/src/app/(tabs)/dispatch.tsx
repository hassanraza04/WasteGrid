import { useSession } from "@/auth/session";
import { LiveDispatch } from "@/components/admin/live-dispatch";
import { AppText, Screen } from "@/components/ui";

export default function Dispatch() {
  const session = useSession();
  return session?.role === "admin" ? <LiveDispatch key={session.userId} />
    : <Screen><AppText>Sign in with an organiser account to dispatch routes.</AppText></Screen>;
}
