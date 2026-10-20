"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  BULLETINS_LIVE_TWO_URL,
  bulletinCheckPath,
  bulletinCoordinates,
  bulletinMonthLabel,
  canonicalRegistration,
  parseBulletinResponse,
  type BulletinCheck as BulletinAnswer,
  type BulletinLimitation,
} from "@/lib/bulletins";
import type { LabelIndex } from "@/lib/planner-data";

// The server makes up to three rounds of 8 second EPA calls; past this the card stops waiting.
const CLIENT_TIMEOUT_MS = 25_000;

type Status = "checking" | "no-limits" | "limits" | "unavailable";

function BulletinsLink() {
  return (
    <a
      href={BULLETINS_LIVE_TWO_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="font-black underline decoration-2 underline-offset-4 outline-offset-2 focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-current"
    >
      Bulletins Live! Two
    </a>
  );
}

async function requestBulletinCheck(path: string, regs: string[], signal: AbortSignal): Promise<BulletinAnswer> {
  const response = await fetch(path, { headers: { accept: "application/json" }, signal });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const parsed = parseBulletinResponse(payload, regs);
  if (response.ok) return parsed;
  return { status: "unavailable", reason: parsed.status === "unavailable" ? parsed.reason : `HTTP ${response.status}` };
}

export function BulletinCheck({ lat, lon, regs, month, labels, onDark }: {
  lat: number;
  lon: number;
  regs: string[];
  month: string;
  labels: LabelIndex;
  onDark: boolean;
}) {
  const path = bulletinCheckPath(lat, lon, regs, month);
  const [answer, setAnswer] = useState<{ path: string; value: BulletinAnswer } | null>(null);

  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    const requested = new URL(path, window.location.origin).searchParams.get("regs")?.split(",") ?? [];
    requestBulletinCheck(path, requested, controller.signal)
      .then((value) => { if (current) setAnswer({ path, value }); })
      .catch(() => {
        if (current) setAnswer({ path, value: { status: "unavailable", reason: "The bulletin check did not answer." } });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      current = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [path]);

  const shown = answer?.path === path ? answer.value : null;
  const status: Status = shown === null
    ? "checking"
    : shown.status === "unavailable"
      ? "unavailable"
      : shown.limitations.length === 0 ? "no-limits" : "limits";
  const tone = onDark ? "text-white/90" : "text-[#14213d]/80";
  const monthLabel = bulletinMonthLabel(month);
  const coordinates = <span className="whitespace-nowrap font-black">{bulletinCoordinates(lat, lon)}</span>;

  return (
    <div
      data-bulletin
      data-bulletin-status={status}
      data-bulletin-checked-at={shown?.status === "checked" ? shown.checkedAt : undefined}
      aria-live="polite"
      className={`mt-3 text-sm font-semibold ${tone}`}
    >
      {/* Labelhand reads label weather limits only. EPA's Bulletins Live! Two holds the field-specific
          endangered species limits; its Location Search takes "latitude, longitude" (checked 2026-10-20). */}
      {status === "checking" ? (
        <p>Checking EPA&apos;s Bulletins Live! Two for endangered species limits at this field...</p>
      ) : null}

      {status === "no-limits" ? (
        <p>
          EPA <BulletinsLink /> lists no endangered species limits for these products at this field in {monthLabel}.
          Informational, not a Bulletin.
        </p>
      ) : null}

      {status === "limits" && shown?.status === "checked" ? (
        <LimitsFound limitations={shown.limitations} regs={regs} labels={labels} monthLabel={monthLabel} coordinates={coordinates} onDark={onDark} />
      ) : null}

      {status === "unavailable" ? (
        <p>
          Endangered species limits are not checked here. In EPA&apos;s <BulletinsLink />, search {coordinates} and enter each EPA Reg. No. in the tank to see this field&apos;s bulletin.
        </p>
      ) : null}
    </div>
  );
}

function LimitsFound({ limitations, regs, labels, monthLabel, coordinates, onDark }: {
  limitations: BulletinLimitation[];
  regs: string[];
  labels: LabelIndex;
  monthLabel: string;
  coordinates: ReactNode;
  onDark: boolean;
}) {
  const byReg = new Map<string, BulletinLimitation[]>();
  for (const limitation of limitations) byReg.set(limitation.reg, [...(byReg.get(limitation.reg) ?? []), limitation]);
  const tankOrder = regs.map(canonicalRegistration);
  const groups = [...byReg.entries()].sort(([left], [right]) => tankOrder.indexOf(left) - tankOrder.indexOf(right));
  const productName = (reg: string) => {
    const label = Object.values(labels).find((candidate) => canonicalRegistration(candidate.reg) === reg);
    return label?.shortName ?? label?.product;
  };

  return (
    <>
      <p className="font-black">
        EPA Bulletins Live! Two lists endangered species limits for these products at this field in {monthLabel}. Informational, not a Bulletin.
      </p>
      <ul className="mt-2 grid gap-3">
        {groups.map(([reg, items]) => {
          const name = productName(reg);
          return (
            <li key={reg} data-bulletin-reg={reg} className={`rounded-xl border-2 p-3 ${onDark ? "border-white/60" : "border-[#14213d]/50 bg-[#fbf7ee]/60"}`}>
              <p className="font-black">{name ? `${name}, EPA Reg. ${reg}` : `EPA Reg. ${reg}`}</p>
              <ul className="mt-1 grid gap-2">
                {items.map((item) => (
                  <li key={`${item.pula_id}-${item.code}-${item.text}`} data-bulletin-limitation>
                    <span className="font-black">{item.code}</span>, PULA {item.pula_id}: {item.text}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
      <p className="mt-2">
        Search {coordinates} in <BulletinsLink />. Get the official bulletin there before you spray.
      </p>
    </>
  );
}
