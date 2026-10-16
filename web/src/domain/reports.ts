export type ReportStatus = "submitted" | "in-progress" | "resolved";

export interface ReportLocation {
  latitude: number;
  longitude: number;
  address: string;
}

export interface ReportUpdate {
  createdAt: string;
  status: ReportStatus;
  message: string;
}

export interface ConversationMessage {
  createdAt: string;
  direction: "inbound" | "outbound";
  body: string;
}

export interface Report {
  reference: string;
  title: string;
  status: ReportStatus;
  location: ReportLocation;
  createdAt: string;
  latestUpdate: ReportUpdate;
  updates: ReportUpdate[];
  conversation: ConversationMessage[];
}

export interface CreateReportInput {
  title: string;
  address: string;
}
