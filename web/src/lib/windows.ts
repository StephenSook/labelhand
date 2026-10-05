import type { EvaluatedHour } from "@/engine";

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface ForecastWindow {
  start: string;
  end: string;
  length: number;
}

export function forecastPermittedWindows(
  hours: EvaluatedHour[],
  jobHours = 3,
): ForecastWindow[] {
  if (!Number.isInteger(jobHours) || jobHours < 1) {
    throw new RangeError("jobHours must be a positive integer.");
  }

  const windows: ForecastWindow[] = [];
  let run: EvaluatedHour[] = [];

  const finishRun = () => {
    if (run.length >= jobHours) {
      const lastStart = Date.parse(run.at(-1)!.start);
      windows.push({
        start: run[0].start,
        end: new Date(lastStart + ONE_HOUR_MS).toISOString(),
        length: run.length,
      });
    }
    run = [];
  };

  for (const hour of hours) {
    const previous = run.at(-1);
    const followsPrevious =
      !previous || Date.parse(hour.start) - Date.parse(previous.start) === ONE_HOUR_MS;
    if (hour.state !== "PERMITTED" || !followsPrevious) {
      finishRun();
    }
    if (hour.state === "PERMITTED") {
      run.push(hour);
    }
  }
  finishRun();

  return windows;
}
