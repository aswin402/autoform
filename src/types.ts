export interface Attendee {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  role: string;
  telegram: string;
  twitter: string;
  linkedin: string;
  website: string;
  pitch: string;
  gender: string;
  age: number;
  country: string;
  persona: {
    bio: string;
    primaryTrack: string;
    interests: string[];
  };
  qaMemory: Record<string, string>;
}

export interface EventItem {
  id: number;
  title: string;
  url: string;
  date?: string;
  category?: string;
  isLuma: boolean;
  soldOut: boolean;
}

export interface FieldRecord {
  label: string;
  type: string;
  name?: string;
  placeholder?: string;
  isRequired: boolean;
  isCombobox: boolean;
  valueFilled?: string;
  options?: string[];
}

export interface EventResult {
  eventId: number;
  eventTitle: string;
  eventUrl: string;
  attendeeId?: string;
  attendeeName: string;
  attendeeEmail: string;
  status: "confirmed_success" | "waitlist_joined" | "failed";
  alreadyRegistered?: boolean;
  failureReason?: string;
  requiredFields: FieldRecord[];
  allFields: FieldRecord[];
  timestamp: string;
  durationSeconds?: number;
}

export interface LogEntry {
  time: string;
  message: string;
  type: "info" | "success" | "warn" | "error" | "pacing";
}

export interface LiveState {
  status: "idle" | "running" | "paused" | "finished" | "stopped";
  updatedAt: string;
  attendee: {
    id: string;
    name: string;
    email: string;
    company: string;
    gender: string;
    age: number;
    country: string;
  };
  lastProcessedIndex?: number;
  lastProcessedEventId?: number;
  stats: {
    totalPending: number;
    totalAttempted: number;
    successCount: number;
    waitlistCount: number;
    failedCount: number;
    remainingCount: number;
  };
  currentEvent: {
    index: number;
    total: number;
    eventId: number;
    eventTitle: string;
    eventUrl: string;
    step: string;
    stepDetail?: string;
    elapsedSeconds: number;
  } | null;
  breather: {
    active: boolean;
    remainingSec: number;
    totalSec: number;
  };
  recentLogs: LogEntry[];
  successEvents: EventResult[];
  unsuccessEvents: EventResult[];
}

export interface TeamMemberSummary {
  attendeeId: string;
  name: string;
  email: string;
  company: string;
  lastProcessedIndex: number;
  lastProcessedEventId?: number;
  totalPending: number;
  totalAttempted: number;
  successCount: number;
  waitlistCount: number;
  failedCount: number;
  remainingCount: number;
  status: string;
  updatedAt: string;
}

export interface RunnerOptions {
  attendeeId?: string;
  startFromIndex?: number;
  limit?: number;
  reset?: boolean;
  retryFailed?: boolean;
  headless?: boolean;
  fieldDelayMs?: number;
  eventDelayMs?: number;
  enableBreather?: boolean;
}

