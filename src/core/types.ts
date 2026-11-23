export type IssueType = "pothole" | "other_road_damage" | "not_a_road_issue";
export type Severity = "Low" | "Medium" | "High";
export type Status =
  | "drafted"
  | "submitted"
  | "acknowledged"
  | "in_progress"
  | "resolved"
  | "rejected";
export type EscalationLevel = "ward_engineer" | "zone" | "commissioner";

export const ISSUE_TYPES: readonly IssueType[] = ["pothole", "other_road_damage", "not_a_road_issue"];
export const SEVERITIES: readonly Severity[] = ["Low", "Medium", "High"];
export const OFFICER_STATUSES: readonly Status[] = ["acknowledged", "in_progress", "resolved", "rejected"];
export const ESCALATION_LEVELS: readonly EscalationLevel[] = ["ward_engineer", "zone", "commissioner"];

export interface EscalationStep {
  level: EscalationLevel;
  days: number | null;
  due: string | null;
}

export interface StatusHistoryEntry {
  status: Status;
  at: string;
  note: string | null;
}

export interface Complaint {
  tracking_id: string;
  reporter: { channel: "whatsapp" | "web"; contact: string | null; name?: string | null };
  location: {
    lat: number;
    lng: number;
    address: string | null;
    ward: string | null;
    zone: string | null;
  };
  photos: string[];
  issue_type: IssueType;
  severity: Severity;
  text: { en: string; kn: string };
  needs_human_review: boolean;
  status: Status;
  status_history: StatusHistoryEntry[];
  created_at: string;
  escalation: EscalationStep[];
}
