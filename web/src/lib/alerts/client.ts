import type {
  AlertConfirmRequest,
  AlertConfirmResponse,
  AlertStartRequest,
  AlertStartResponse,
} from "./types";

export class AlertsClientError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function postJson<TResponse>(url: string, body: unknown): Promise<TResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { error?: string } & TResponse;
  if (!response.ok) throw new AlertsClientError(payload.error ?? `Alerts request returned HTTP ${response.status}.`, response.status);
  return payload;
}

export function startAlertVerification(input: AlertStartRequest): Promise<AlertStartResponse> {
  return postJson<AlertStartResponse>("/api/alerts/start", input);
}

export function confirmAlertVerification(input: AlertConfirmRequest): Promise<AlertConfirmResponse> {
  return postJson<AlertConfirmResponse>("/api/alerts/confirm", input);
}

export type {
  AlertConfirmRequest,
  AlertConfirmResponse,
  AlertStartRequest,
  AlertStartResponse,
  AlertVerificationChannel,
} from "./types";
