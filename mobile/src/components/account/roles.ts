import type { Tone } from "@/theme";
import type { Role } from "@/auth/session";

// How each role is named and colored wherever it's shown, in display order
export const ROLES: { value: Role; label: string; tone: Tone }[] = [
  { value: "user", label: "User", tone: "success" },
  { value: "crew", label: "Crew", tone: "warning" },
  { value: "admin", label: "Admin", tone: "info" },
];

export function roleInfo(role: Role) {
  return ROLES.find((r) => r.value === role)!;
}
