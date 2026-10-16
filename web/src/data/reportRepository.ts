import type { CreateReportInput, Report } from "../domain/reports";

export interface ReportRepository {
  list(): Report[];
  getByReference(reference: string): Report | undefined;
  create(input: CreateReportInput): Report;
  remember(reference: string): void;
  getRememberedReference(): string | undefined;
}
