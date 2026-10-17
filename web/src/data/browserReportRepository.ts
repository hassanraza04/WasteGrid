import type { CreateReportInput, Report, ReportStatus } from "../domain/reports";
import type { ReportRepository } from "./reportRepository";

const reportsKey = "wastegrid.demo.reports";
const rememberedReferenceKey = "wastegrid.demo.last-report";

export class ReportStorageError extends Error {
  public constructor() {
    super("Report storage is unavailable");
    this.name = "ReportStorageError";
  }
}

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
    const title = requireValue(input.title, "Report title is required");
    const address = requireValue(input.address, "Report address is required");
    const createdAt = new Date().toISOString();
    const report = createReport(this.createReference(), title, address, createdAt);

    this.writeReports([...this.readReports(), report]);
    return report;
  }

  public remember(reference: string): void {
    if (this.getByReference(reference)) {
      this.writeStorage(rememberedReferenceKey, reference.trim().toUpperCase());
    }
  }

  public getRememberedReference(): string | undefined {
    return this.readStorage(rememberedReferenceKey) ?? undefined;
  }

  private createReference(): string {
    return `WG-${Date.now().toString(36).toUpperCase()}-${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
  }

  private readReports(): Report[] {
    const serializedReports = this.readStorage(reportsKey);
    if (!serializedReports) {
      this.writeReports([seededReport]);
      return [seededReport];
    }

    try {
      const parsedReports: unknown = JSON.parse(serializedReports);
      return Array.isArray(parsedReports) && parsedReports.every(isReport)
        ? parsedReports
        : this.resetReports();
    } catch {
      return this.resetReports();
    }
  }

  private writeReports(reports: Report[]): void {
    this.writeStorage(reportsKey, JSON.stringify(reports));
  }

  private resetReports(): Report[] {
    this.writeReports([seededReport]);
    return [seededReport];
  }

  private readStorage(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      throw new ReportStorageError();
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      throw new ReportStorageError();
    }
  }
}

function requireValue(value: string, errorMessage: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error(errorMessage);
  }
  return trimmedValue;
}

function createReport(reference: string, title: string, address: string, createdAt: string): Report {
  const update = {
    createdAt,
    status: "submitted" as const,
    message: "Your report has been received.",
  };
  return {
    reference,
    title,
    status: "submitted",
    location: { latitude: 0, longitude: 0, address },
    createdAt,
    latestUpdate: update,
    updates: [update],
    conversation: [],
  };
}

function isReport(value: unknown): value is Report {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isString(value.reference) &&
    isString(value.title) &&
    isReportStatus(value.status) &&
    isReportLocation(value.location) &&
    isString(value.createdAt) &&
    isReportUpdate(value.latestUpdate) &&
    Array.isArray(value.updates) &&
    value.updates.every(isReportUpdate) &&
    Array.isArray(value.conversation) &&
    value.conversation.every(isConversationMessage)
  );
}

function isReportLocation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.latitude) &&
    isNumber(value.longitude) &&
    isString(value.address)
  );
}

function isReportUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.createdAt) &&
    isReportStatus(value.status) &&
    isString(value.message)
  );
}

function isConversationMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.createdAt) &&
    (value.direction === "inbound" || value.direction === "outbound") &&
    isString(value.body)
  );
}

function isReportStatus(value: unknown): value is ReportStatus {
  return value === "submitted" || value === "in-progress" || value === "resolved";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
