import { afterEach, describe, expect, test, vi } from "vitest";

import { AlertsConfigError } from "@/lib/alerts/config";
import { jsonError } from "@/lib/alerts/http";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("alert JSON errors", () => {
  test("keeps 503 for a site where alerts are not configured", async () => {
    const response = jsonError(new AlertsConfigError("Alerts are not configured."));
    expect(response.status).toBe(503);
  });

  test("logs an unexpected error and answers 500, not the not-configured 503", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const blobError = new Error("Vercel Blob: This blob already exists");
    blobError.name = "BlobError";
    const response = jsonError(blobError);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Alerts hit an unexpected error. Try again in a minute.", status: 500 });
    expect(log).toHaveBeenCalledWith("alerts: unexpected error", "BlobError: Vercel Blob: This blob already exists");
  });
});
