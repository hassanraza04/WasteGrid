import { Tabs } from "expo-router/js-tabs";

import { Icon, TabBar, type IconName } from "@/components/ui";
import { Colors } from "@/theme";

// Tab order, titles and icons. Each name matches a file in app/(tabs)/.
const TABS: { name: string; title: string; icon: IconName }[] = [
  { name: "index", title: "Map", icon: "map" },
  { name: "reports", title: "Reports", icon: "file-text" },
  { name: "stats", title: "Stats", icon: "bar-chart-2" },
  { name: "account", title: "Account", icon: "user" },
];

export default function AppTabs() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: Colors.background } }}>
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          // `as string`: TabBar always passes a theme color
          options={{ title: tab.title, tabBarIcon: ({ color, size }) => <Icon name={tab.icon} size={size} color={color as string} /> }}
        />
      ))}
    </Tabs>
  );
}
