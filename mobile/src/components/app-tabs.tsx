import { Tabs } from "expo-router/js-tabs";

import { Icon, TabBar, type IconName } from "@/components/ui";
import { useSession, type Role } from "@/auth/session";
import { Colors } from "@/theme";

type Tab = {
  name: string; // matches a file in app/(tabs)/
  title: string;
  icon: IconName;
  roles?: Role[]; // only these roles see the tab; everyone if omitted
};

// Tab order, titles, icons and who sees what
const TABS: Tab[] = [
  { name: "index", title: "Map", icon: "map" },
  { name: "dispatch", title: "Dispatch", icon: "truck", roles: ["admin"] },
  { name: "my-route", title: "My route", icon: "navigation", roles: ["crew"] },
  { name: "reports", title: "Reports", icon: "file-text" },
];

export default function AppTabs() {
  const session = useSession();
  const canSee = (tab: Tab) => !tab.roles || (!!session && tab.roles.includes(session.role));

  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: Colors.background } }}>
      {TABS.map((tab) => (
        // Protected removes the tab (and its route) for roles that can't see it
        <Tabs.Protected key={tab.name} guard={canSee(tab)}>
          <Tabs.Screen
            name={tab.name}
            // `as string`: TabBar always passes a theme color
            options={{ title: tab.title, tabBarIcon: ({ color, size }) => <Icon name={tab.icon} size={size} color={color as string} /> }}
          />
        </Tabs.Protected>
      ))}
      {/* Illustrative statistics stay out of the live app until connected. */}
      <Tabs.Protected guard={false}>
        <Tabs.Screen name="stats" />
      </Tabs.Protected>
    </Tabs>
  );
}
