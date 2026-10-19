import type { AgentCheckTankResult } from "@/lib/agent/tools";

export type AlertVerificationChannel = "sms" | "call";

export type AlertStartRequest = {
  field: string;
  tankRegs: string[];
  jobHours: number;
  phoneNumber: string;
  channel?: AlertVerificationChannel;
};

export type AlertStartResponse = {
  verificationId: string;
  status: "pending";
  channel: AlertVerificationChannel;
};

export type AlertConfirmRequest = {
  verificationId: string;
  code: string;
};

export type AlertConfirmResponse = {
  subscriptionId: string;
  status: "active";
};

export type PendingAlertVerification = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  field: string;
  tankRegs: string[];
  jobHours: number;
  phoneNumber: string;
  phoneHash: string;
  channel: AlertVerificationChannel;
};

export type AlertSubscription = {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  verifiedAt: string;
  active: boolean;
  field: string;
  tankRegs: string[];
  jobHours: number;
  phoneNumber?: string;
  phoneHash: string;
  channel: AlertVerificationChannel;
  unsubscribedAt?: string;
};

export type AlertPlannerEvidence = {
  fieldKey: string;
  fieldName: string;
  products: Array<{ reg: string; name: string }>;
  source: "LIVE";
  fetchedAt: string;
  jobHours: number;
  calledWindow: { start: string; end: string; hours: number };
  agentCheck: AgentCheckTankResult;
  fallbackSummary: string;
};

export type AlertCallLog = {
  schemaVersion: 1;
  id: string;
  subscriptionId: string;
  phoneHash: string;
  createdAt: string;
  easternDay: string;
  status: "reserved" | "queued" | "failed";
  planner: AlertPlannerEvidence;
  twilioCallSid?: string;
  failure?: string;
};

export type AlertsRunResult = {
  scanned: number;
  called: number;
  noWindow: number;
  duplicate: number;
  capped: number;
  failed: number;
  cleanupFailed: boolean;
  quietHours: boolean;
};
