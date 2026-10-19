"use client";

import { useState } from "react";
import { AlertsClientError, confirmAlertVerification, startAlertVerification, type AlertVerificationChannel } from "@/lib/alerts/client";

type Props = {
  field: string;
  fieldName: string;
  tankRegs: string[];
  jobHours: number;
};

type Step =
  | { kind: "form" }
  | { kind: "sending" }
  | { kind: "code"; verificationId: string; channel: AlertVerificationChannel }
  | { kind: "confirming"; verificationId: string; channel: AlertVerificationChannel }
  | { kind: "active" };

// US numbers typed any common way: (516) 555-0100, 516.555.0100, +1 516 555 0100.
export function usE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}

function messageFor(error: unknown): string {
  if (error instanceof AlertsClientError) {
    if (error.status === 503) return "Phone alerts are not switched on for this site yet.";
    if (error.status === 429) return "Today's verification limit is reached. Try again tomorrow.";
    return error.message;
  }
  return "The request did not reach Labelhand. Check the connection and try again.";
}

export function CallMe({ field, fieldName, tankRegs, jobHours }: Props) {
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<AlertVerificationChannel>("sms");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    const phoneNumber = usE164(phone);
    if (!phoneNumber) {
      setError("Enter a 10-digit US phone number.");
      return;
    }
    setError(null);
    setStep({ kind: "sending" });
    try {
      const started = await startAlertVerification({ field, tankRegs, jobHours, phoneNumber, channel });
      setStep({ kind: "code", verificationId: started.verificationId, channel: started.channel });
    } catch (failure) {
      setError(messageFor(failure));
      setStep({ kind: "form" });
    }
  };

  const confirm = async (verificationId: string, sentBy: AlertVerificationChannel) => {
    if (!/^\d{4,10}$/.test(code.trim())) {
      setError("Enter the code from the text or call.");
      return;
    }
    setError(null);
    setStep({ kind: "confirming", verificationId, channel: sentBy });
    try {
      await confirmAlertVerification({ verificationId, code: code.trim() });
      setStep({ kind: "active" });
    } catch (failure) {
      setError(messageFor(failure));
      setStep({ kind: "code", verificationId, channel: sentBy });
    }
  };

  return (
    <section
      aria-labelledby="call-me-heading"
      data-call-me={step.kind}
      className="mt-5 rounded-[2rem] border-[3px] border-[#14213d] bg-[#fff0b8] p-5 text-[#14213d] shadow-[5px_7px_0_#14213d] sm:p-7"
    >
      <h2 id="call-me-heading" className="display text-[clamp(1.8rem,3.2vw,2.6rem)] leading-[0.95]">
        Call me when this tank can spray
      </h2>
      <p className="mt-3 max-w-3xl font-semibold leading-relaxed">
        Labelhand checks {fieldName} against the new NWS forecast every hour. The first time a forecast-permitted run of {jobHours}{" "}
        {jobHours === 1 ? "hour" : "hours"} opens within the next 36 hours for this tank, it calls you, reads the window, and can read
        the label clauses that limit the rest of the day. No calls from 9 PM to 6 AM Eastern, at most 3 a day. Press 9 on any call to stop.
      </p>

      {step.kind === "active" ? (
        <p role="status" className="mt-5 rounded-2xl border-2 border-[#14213d] bg-[#216a38] p-4 font-black text-white">
          You are subscribed. Labelhand will call when {fieldName} has a {jobHours}-hour window for this tank.
        </p>
      ) : step.kind === "form" || step.kind === "sending" ? (
        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <div>
            <label htmlFor="call-me-phone" className="block text-sm font-black">US phone number</label>
            <input
              id="call-me-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="(229) 555-0100"
              className="mt-1 min-h-12 w-56 rounded-2xl border-2 border-[#14213d] bg-white px-4 font-extrabold"
            />
          </div>
          <fieldset className="flex gap-2">
            <legend className="text-sm font-black">Send the code by</legend>
            {(["sms", "call"] as const).map((option) => (
              <label key={option} className="mt-1 flex min-h-12 cursor-pointer items-center gap-2 rounded-full border-2 border-[#14213d] bg-white px-4 font-bold">
                <input type="radio" name="call-me-channel" checked={channel === option} onChange={() => setChannel(option)} className="accent-[#216a38]" />
                {option === "sms" ? "Text" : "Call"}
              </label>
            ))}
          </fieldset>
          <button
            type="submit"
            disabled={step.kind === "sending" || tankRegs.length === 0}
            className="min-h-12 rounded-full border-[3px] border-[#14213d] bg-[#ffc53d] px-5 font-black shadow-[3px_4px_0_#14213d] disabled:opacity-60"
          >
            {step.kind === "sending" ? "Sending the code" : "Send me a code"}
          </button>
        </form>
      ) : (
        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void confirm(step.verificationId, step.channel);
          }}
        >
          <div>
            <label htmlFor="call-me-code" className="block text-sm font-black">
              Code from the {step.channel === "sms" ? "text" : "call"}
            </label>
            <input
              id="call-me-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="mt-1 min-h-12 w-40 rounded-2xl border-2 border-[#14213d] bg-white px-4 font-extrabold tracking-[0.2em]"
            />
          </div>
          <button
            type="submit"
            disabled={step.kind === "confirming"}
            className="min-h-12 rounded-full border-[3px] border-[#14213d] bg-[#ffc53d] px-5 font-black shadow-[3px_4px_0_#14213d] disabled:opacity-60"
          >
            {step.kind === "confirming" ? "Checking the code" : "Subscribe"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep({ kind: "form" });
              setCode("");
              setError(null);
            }}
            className="min-h-12 rounded-full border-2 border-[#14213d] bg-white px-4 text-sm font-black"
          >
            Use a different number
          </button>
        </form>
      )}

      {error && (
        <p role="alert" className="mt-4 rounded-2xl border-2 border-[#b53432] bg-[#f8ddda] p-3 font-bold">
          {error}
        </p>
      )}
      <p className="mt-4 max-w-3xl text-sm font-semibold text-[#14213d]/80">
        Twilio Verify sends the code; Labelhand never stores it. Your number is kept in private storage only to place these calls, and
        Labelhand looks it up by a keyed hash.
      </p>
    </section>
  );
}
