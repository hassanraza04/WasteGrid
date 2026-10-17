export interface HostedDashboardConfig {
  apiBaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export class ConfigurationError extends Error {
  public constructor(setting: string) {
    super(`${setting} must be configured for the organizer dashboard.`);
    this.name = "ConfigurationError";
  }
}

export function readHostedDashboardConfig(
  environment: Record<string, string | undefined>,
): HostedDashboardConfig {
  return {
    apiBaseUrl: requiredUrl(environment, "VITE_API_BASE_URL"),
    supabaseUrl: requiredUrl(environment, "VITE_SUPABASE_URL"),
    supabasePublishableKey: requiredValue(environment, "VITE_SUPABASE_PUBLISHABLE_KEY"),
  };
}

function requiredUrl(
  environment: Record<string, string | undefined>,
  setting: string,
): string {
  return requiredValue(environment, setting).replace(/\/+$/, "");
}

function requiredValue(
  environment: Record<string, string | undefined>,
  setting: string,
): string {
  const value = environment[setting]?.trim();
  if (!value) {
    throw new ConfigurationError(setting);
  }
  return value;
}
