import type { CreateReportInput, Report } from "../domain/reports";
import type { ReportRepository } from "./reportRepository";

const reportsKey = "wastegrid.demo.reports";
const rememberedReferenceKey = "wastegrid.demo.last-report";

const seededReport: Report = {
  reference: "WG-DEMO",
  title: "Overflowing bin",
  status: "in-progress",
  location: {
    latitude: 40.7128,
    longitude: -74.006,
    address: "14 Market Street",
  },
  createdAt: "2026-10-16T12:00:00.000Z",
  latestUpdate: {
    createdAt: "2026-10-16T13:00:00.000Z",
    status: "in-progress",
    message: "A collection crew has been assigned.",
  },
  updates: [
    {
      createdAt: "2026-10-16T13:00:00.000Z",
      status: "in-progress",
      message: "A collection crew has been assigned.",
    },
  ],
  conversation: [],
};

export class BrowserReportRepository implements ReportRepository {
  public constructor(private readonly storage: Storage) {}

  public list(): Report[] {
    return this.readReports();
  }

  public getByReference(reference: string): Report | undefined {
    const normalizedReference = reference.trim().toUpperCase();
    return this.readReports().find((report) => report.reference === normalizedReference);
  }

  public create(input: CreateReportInput): Report {
    const title = input.title.trim();
    const address = input.address.trim();
    if (!title) {
      throw new Error("Report title is required");
    }
    if (!address) {
      throw new Error("Report address is required");
    }

    const createdAt = new Date().toISOString();
    const update = {
      createdAt,
      status: "submitted" as const,
      message: "Your report has been received.",
    };
    const report: Report = {
      reference: this.createReference(),
      title,
      status: "submitted",
      location: { latitude: 0, longitude: 0, address },
      createdAt,
      latestUpdate: update,
      updates: [update],
      conversation: [],
    };

    this.writeReports([...this.readReports(), report]);
    return report;
  }

  public remember(reference: string): void {
    if (this.getByReference(reference)) {
      this.storage.setItem(rememberedReferenceKey, reference.trim().toUpperCase());
    }
  }

  public getRememberedReference(): string | undefined {
    return this.storage.getItem(rememberedReferenceKey) ?? undefined;
  }

  private createReference(): string {
    return `WG-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
  }

  private readReports(): Report[] {
    const serializedReports = this.storage.getItem(reportsKey);
    if (!serializedReports) {
      this.writeReports([seededReport]);
      return [seededReport];
    }

    try {
      const parsedReports: unknown = JSON.parse(serializedReports);
      return Array.isArray(parsedReports) ? (parsedReports as Report[]) : [seededReport];
    } catch {
      return [seededReport];
    }
  }

  private writeReports(reports: Report[]): void {
    this.storage.setItem(reportsKey, JSON.stringify(reports));
  }
}
