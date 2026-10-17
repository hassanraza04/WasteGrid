export interface OrganizerIdentity {
  role: string;
}

export interface OrganizerReport {
  id: string;
  publicReference: string;
  title: string;
  dashboardStatus: string;
  address: string | null;
}

export interface OrganizerApi {
  getIdentity(accessToken: string): Promise<OrganizerIdentity>;
  listReports(accessToken: string): Promise<OrganizerReport[]>;
}

export class OrganizerApiError extends Error {
  public constructor(public readonly kind: "unauthorized" | "request-failed") {
    super(
      kind === "unauthorized"
        ? "Your organizer session has expired."
        : "Reports could not be loaded.",
    );
    this.name = "OrganizerApiError";
  }
}

type Fetcher = typeof fetch;

interface OrganizerReportResponse {
  id: string;
  public_reference: string;
  title: string;
  dashboard_status: string;
  address: string | null;
}

export class HostedOrganizerApi implements OrganizerApi {
  public constructor(
    private readonly baseUrl: string,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  public async getIdentity(accessToken: string): Promise<OrganizerIdentity> {
    return this.request<OrganizerIdentity>("/auth/me", accessToken);
  }

  public async listReports(accessToken: string): Promise<OrganizerReport[]> {
    const reports = await this.request<OrganizerReportResponse[]>(
      "/organizer/reports",
      accessToken,
    );
    return reports.map((report) => ({
      id: report.id,
      publicReference: report.public_reference,
      title: report.title,
      dashboardStatus: report.dashboard_status,
      address: report.address,
    }));
  }

  private async request<T>(path: string, accessToken: string): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new OrganizerApiError(
        response.status === 401 ? "unauthorized" : "request-failed",
      );
    }
    return response.json() as Promise<T>;
  }
}
