import twilio from "twilio";

import type { AlertsConfig } from "./config";

export type VerificationStatus = "approved" | "pending" | "failed" | "expired" | string;
export const VERIFY_RATE_LIMIT_KEY = "phone_hash";

export interface AlertTwilio {
  startVerification(phoneNumber: string, channel: "sms" | "call", phoneHash: string): Promise<void>;
  checkVerification(phoneNumber: string, code: string): Promise<VerificationStatus>;
  placeCall(phoneNumber: string, twiml: string): Promise<{ sid: string }>;
  validate(signature: string, url: string, params: Record<string, string>): boolean;
}

export class TwilioCallRequestError extends Error {
  constructor(readonly definitelyNotPlaced: boolean) {
    super("Twilio call request failed.");
  }
}

export class TwilioVerificationRequestError extends Error {
  constructor(readonly definitelyNotSent: boolean) {
    super("Twilio verification request failed.");
  }
}

export class TwilioAlertGateway implements AlertTwilio {
  private readonly client;

  constructor(private readonly config: AlertsConfig) {
    this.client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }

  async startVerification(phoneNumber: string, channel: "sms" | "call", phoneHash: string): Promise<void> {
    try {
      await this.client.verify.v2.services(this.config.twilioVerifyServiceSid).verifications.create({
        to: phoneNumber,
        channel,
        rateLimits: { [VERIFY_RATE_LIMIT_KEY]: phoneHash },
      });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : Number.NaN;
      throw new TwilioVerificationRequestError(Number.isInteger(status) && status >= 400 && status < 500);
    }
  }

  async checkVerification(phoneNumber: string, code: string): Promise<VerificationStatus> {
    const checked = await this.client.verify.v2.services(this.config.twilioVerifyServiceSid).verificationChecks.create({
      to: phoneNumber,
      code,
    });
    return checked.status;
  }

  async placeCall(phoneNumber: string, twimlBody: string): Promise<{ sid: string }> {
    try {
      const call = await this.client.calls.create({
        to: phoneNumber,
        from: this.config.twilioFromNumber,
        twiml: twimlBody,
      });
      return { sid: call.sid };
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : Number.NaN;
      throw new TwilioCallRequestError(Number.isInteger(status) && status >= 400 && status < 500);
    }
  }

  validate(signature: string, url: string, params: Record<string, string>): boolean {
    return twilio.validateRequest(this.config.twilioAuthToken, signature, url, params);
  }
}

export function initialCallTwiml(prompt: string, whyUrl: string): string {
  const response = new twilio.twiml.VoiceResponse();
  const gather = response.gather({
    action: whyUrl,
    actionOnEmptyResult: false,
    hints: "why,stop",
    input: ["speech", "dtmf"],
    method: "POST",
    numDigits: 1,
    speechTimeout: "auto",
    timeout: 5,
  });
  gather.say(prompt);
  response.say("No input received. Goodbye.");
  return response.toString();
}

export function sayTwiml(message: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(message);
  return response.toString();
}

export function redirectTwiml(url: string): string {
  const response = new twilio.twiml.VoiceResponse();
  response.redirect({ method: "POST" }, url);
  return response.toString();
}
