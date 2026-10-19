import { createHmac, randomUUID } from "node:crypto";
import { list, put } from "@vercel/blob";

import { COLD_COMPILES_PER_WINDOW, LIMIT_WINDOW_MS, LiveLimitError } from "./live-limits";

// The counters in live-limits.ts live in one function instance. Vercel can run several at once,
// and each would start its own budget, so every cold compile also writes one record to this
// ledger in the Blob store all instances share, and is refused when the shared counts are full.
// Two instances that read the ledger at the same moment can each pass one compile past a cap;
// the overshoot is bounded by how many compiles start in the same instant.
export const SHARED_DAILY_COLD_COMPILES = 40;
export const SHARED_LIFETIME_COLD_COMPILES = 400;
export const LEDGER_PREFIX = "ledger/cold/";

type BlobList = typeof list;
type BlobPut = typeof put;

export interface SharedLedgerOptions {
  ip: string;
  now?: number;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  api?: { list: BlobList; put: BlobPut };
}

function dayOf(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

// The visitor is stored only as a keyed hash, never as an address.
export function visitorKey(ip: string, secret: string): string {
  return createHmac("sha256", secret).update(ip || "unknown").digest("hex").slice(0, 16);
}

export function ledgerPath(now: number, visitor: string, id = randomUUID()): string {
  return `${LEDGER_PREFIX}${dayOf(now)}/${now}-${visitor}-${id}.json`;
}

function parseEntry(pathname: string): { day: string; at: number; visitor: string } | null {
  const match = /^ledger\/cold\/(\d{4}-\d{2}-\d{2})\/(\d+)-([a-f0-9]{16})-[a-f0-9-]+\.json$/.exec(pathname);
  if (!match) return null;
  return { day: match[1], at: Number(match[2]), visitor: match[3] };
}

async function listEntries(api: { list: BlobList }, token: string, maximum: number, signal?: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.list({
      prefix: LEDGER_PREFIX,
      limit: 1_000,
      token,
      ...(cursor ? { cursor } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    });
    names.push(...page.blobs.map((blob) => blob.pathname));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && names.length < maximum);
  return names;
}

export async function reserveSharedColdCompile({
  ip,
  now = Date.now(),
  signal,
  env = process.env,
  api = { list, put },
}: SharedLedgerOptions): Promise<void> {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    // Without the shared store a production deployment has no spend limit across instances.
    if (env.VERCEL_ENV === "production") {
      throw new LiveLimitError("Live label compilation is unavailable because its shared spend ledger is not configured.", 503);
    }
    return;
  }

  let entries: string[];
  try {
    entries = await listEntries(api, token, SHARED_LIFETIME_COLD_COMPILES + 1, signal);
  } catch {
    throw new LiveLimitError("The live label spend ledger could not be read, so no compile was started.", 503);
  }
  if (entries.length >= SHARED_LIFETIME_COLD_COMPILES) {
    throw new LiveLimitError("This demo's allowance of live label compiles is used up.", 503);
  }

  const today = dayOf(now);
  const parsed = entries.map(parseEntry).filter((entry) => entry !== null);
  if (parsed.filter((entry) => entry.day === today).length >= SHARED_DAILY_COLD_COMPILES) {
    throw new LiveLimitError("The live label daily budget has been reached. Try again tomorrow.", 503);
  }

  const visitor = visitorKey(ip, token);
  const recent = parsed
    .filter((entry) => entry.visitor === visitor && entry.at > now - LIMIT_WINDOW_MS)
    .map((entry) => entry.at)
    .sort((a, b) => a - b);
  if (recent.length >= COLD_COMPILES_PER_WINDOW) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + LIMIT_WINDOW_MS - now) / 1_000));
    throw new LiveLimitError("Too many cold label compiles. Try again shortly.", 429, retryAfter);
  }

  try {
    await api.put(ledgerPath(now, visitor), JSON.stringify({ at: new Date(now).toISOString() }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
      token,
      ...(signal ? { abortSignal: signal } : {}),
    });
  } catch {
    throw new LiveLimitError("The live label spend ledger could not be written, so no compile was started.", 503);
  }
}
