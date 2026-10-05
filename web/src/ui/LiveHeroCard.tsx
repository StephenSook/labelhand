"use client";

import { useEffect, useState } from "react";
import { PRODUCT_REGISTRATIONS, errorText, fetchJson, formatForecastTime, parseForecastPoints, type ForecastPoints } from "@/lib/planner-data";
import { runPlannerCheck, type PlannerCheckResult } from "@/lib/run-planner";
import { forecastPermittedWindows } from "@/lib/windows";
import { SquashButton, WorkingCard } from "@/ui";

type HeroState =
  | { status: "idle" }
  | { status: "loading"; startedAt: number }
  | { status: "ready"; result: PlannerCheckResult }
  | { status: "error"; message: string };

export function LiveHeroCard() {
  const [state, setState] = useState<HeroState>({ status: "idle" });

  useEffect(() => {
    let current = true;
    async function run() {
      setState({ status: "loading", startedAt: Date.now() });
      try {
        const payload = await fetchJson<unknown>("/data/nws_points_cache.json");
        const points: ForecastPoints = parseForecastPoints(payload);
        const result = await runPlannerCheck({
          pointKey: "tift",
          registrations: [...PRODUCT_REGISTRATIONS],
          points,
          source: "LIVE",
          fallbackToReplay: true,
        });
        if (current) setState({ status: "ready", result });
      } catch (error) {
        if (current) setState({ status: "error", message: errorText(error) });
      }
    }
    void run();
    return () => { current = false; };
  }, []);

  if (state.status === "idle") {
    return <div className="hero-live-card" aria-label="Starting the Tift forecast check">Starting the Tift forecast check...</div>;
  }

  if (state.status === "loading") {
    return (
      <div className="hero-live-card">
        <WorkingCard
          title="Checking Tift now"
          startedAt={state.startedAt}
          currentStep={0}
          steps={[
            { label: "Fetch NWS forecast", detail: "Running now", status: "active" },
            { label: "Load label rules", detail: "Waiting", status: "waiting" },
            { label: "Run WebAssembly planner", detail: "Waiting", status: "waiting" },
          ]}
        />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <section data-live-hero className="hero-live-card" aria-labelledby="hero-live-error">
        <p className="hand hero-live-note">live check unavailable</p>
        <h2 id="hero-live-error" className="display">The forecast check did not run.</h2>
        <p className="hero-live-error">{state.message}</p>
        <SquashButton href="/app?field=tift&products=5481-504,264-700,264-418&hours=3" variant="secondary">
          Open the planner
        </SquashButton>
      </section>
    );
  }

  const { result } = state;
  const counts = result.hours.reduce((current, hour) => {
    current[hour.state] += 1;
    return current;
  }, { PERMITTED: 0, FIELD_CHECK: 0, BLOCKED: 0 });
  const nextWindow = forecastPermittedWindows(result.hours, 3)[0];
  const params = new URLSearchParams({
    field: result.pointKey,
    products: PRODUCT_REGISTRATIONS.join(","),
    hours: "3",
  });
  if (result.source === "RECORDED") params.set("replay", result.pointKey);

  return (
    <section
      data-live-hero
      data-forecast-source={result.source}
      data-permitted-hours={counts.PERMITTED}
      data-field-check-hours={counts.FIELD_CHECK}
      data-blocked-hours={counts.BLOCKED}
      className="hero-live-card"
      aria-labelledby="hero-live-heading"
    >
      <div className="hero-live-heading">
        <div>
          <p className="hand hero-live-note">Tift · three-product tank · 3 hours</p>
          <h2 id="hero-live-heading" className="display">Next permitted window</h2>
        </div>
        <span className={`hero-live-badge ${result.source === "LIVE" ? "hero-live-badge-live" : "hero-live-badge-recorded"}`}>
          {result.source}
        </span>
      </div>

      <p className="hero-live-time">
        {result.source === "LIVE" ? "NWS fetched" : "NWS forecast recorded"}{" "}
        <time dateTime={result.fetchedAt}>{formatForecastTime(result.fetchedAt)}</time>
      </p>
      {result.liveFailure ? (
        <p className="hero-live-fallback">The live NWS request failed. This card is using the recorded forecast.</p>
      ) : null}

      {nextWindow ? (
        <div className="hero-live-window">
          <strong>{formatDay(nextWindow.start)}</strong>
          <span>{formatClock(nextWindow.start)} to {formatClock(nextWindow.end)}</span>
          <small>Eastern time, the field&apos;s local time</small>
          <small>{nextWindow.length} permitted hours in this run</small>
        </div>
      ) : (
        <p className="hero-live-none">No three-hour permitted window fits in this forecast.</p>
      )}

      <dl className="hero-live-counts">
        <HeroCount term="Permitted" value={counts.PERMITTED} />
        <HeroCount term="Field check" value={counts.FIELD_CHECK} />
        <HeroCount term="Blocked" value={counts.BLOCKED} />
      </dl>

      <SquashButton href={`/app?${params.toString()}#next-window`} variant="secondary">
        Open this check
      </SquashButton>
    </section>
  );
}

function HeroCount({ term, value }: { term: string; value: number }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd className="display">{value}</dd>
    </div>
  );
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}
