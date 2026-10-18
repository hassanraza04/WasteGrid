import { fetch } from "expo/fetch";
import { staffCredentials } from "@/auth/session";
import { StaffClient } from "./staff-client";

export const staffApi = new StaffClient(
  () => process.env.EXPO_PUBLIC_API_BASE_URL ?? "", staffCredentials,
  (url, init) => fetch(url, init),
);
