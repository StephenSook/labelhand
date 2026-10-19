export const ALERT_ENV_NAMES = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_VERIFY_SERVICE_SID",
  "ALERTS_RUN_SECRET",
  "ALERTS_PUBLIC_BASE_URL",
  "BLOB_READ_WRITE_TOKEN",
] as const;

export type AlertsConfig = {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFromNumber: string;
  twilioVerifyServiceSid: string;
  runSecret: string;
  publicBaseUrl: string;
  blobToken: string;
};

export class AlertsConfigError extends Error {
  readonly status = 503;
}

export function readAlertsConfig(env: Record<string, string | undefined> = process.env): AlertsConfig {
  const values = Object.fromEntries(ALERT_ENV_NAMES.map((name) => [name, env[name]?.trim() ?? ""]));
  const missing = ALERT_ENV_NAMES.filter((name) => !values[name]);
  if (missing.length > 0) {
    throw new AlertsConfigError(`Alerts are unavailable because required settings are missing: ${missing.join(", ")}.`);
  }

  let base: URL;
  try {
    base = new URL(values.ALERTS_PUBLIC_BASE_URL);
  } catch {
    throw new AlertsConfigError("Alerts are unavailable because ALERTS_PUBLIC_BASE_URL is invalid.");
  }
  if (env.VERCEL_ENV === "production" && base.protocol !== "https:") {
    throw new AlertsConfigError("Alerts are unavailable because ALERTS_PUBLIC_BASE_URL must use HTTPS in production.");
  }

  return {
    twilioAccountSid: values.TWILIO_ACCOUNT_SID,
    twilioAuthToken: values.TWILIO_AUTH_TOKEN,
    twilioFromNumber: values.TWILIO_FROM_NUMBER,
    twilioVerifyServiceSid: values.TWILIO_VERIFY_SERVICE_SID,
    runSecret: values.ALERTS_RUN_SECRET,
    publicBaseUrl: base.toString().replace(/\/$/, ""),
    blobToken: values.BLOB_READ_WRITE_TOKEN,
  };
}
