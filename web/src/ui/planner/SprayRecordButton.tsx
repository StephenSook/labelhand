"use client";

import { useState } from "react";
import { downloadSprayRecord, type SprayRecordInput } from "@/lib/spray-record";

export function SprayRecordButton({ input, className = "" }: {
  input: SprayRecordInput;
  className?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  async function download() {
    setWorking(true);
    setError(null);
    try {
      await downloadSprayRecord(input);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        disabled={working}
        onClick={() => void download()}
        className="min-h-11 rounded-full border-2 border-[#14213d] bg-[#ffc53d] px-4 py-2 text-sm font-black text-[#14213d] outline-offset-2 hover:bg-[#ffd873] focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-white disabled:cursor-wait disabled:opacity-65"
      >
        {working ? "Building spray record..." : "Download spray record (PDF)"}
      </button>
      {error ? <p className="mt-2 text-sm font-bold text-[#9f2926]" role="alert">The spray record could not be built: {error}</p> : null}
    </div>
  );
}
