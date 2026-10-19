import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GET, seasonObjectKey } from "@/app/api/season/[...path]/route";

function context(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

describe("season Object Storage route", () => {
  beforeEach(() => {
    vi.stubEnv("SEASON_BUCKET", "season-test");
    vi.stubEnv("SEASON_S3_ENDPOINT", "https://storage.eu-north1.nebius.cloud");
    vi.stubEnv("SEASON_READ_KEY_ID", "test-read-key");
    vi.stubEnv("SEASON_READ_SECRET", "test-read-secret");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("accepts only the index or a known point and real ISO day", () => {
    expect(seasonObjectKey(["index.json"])).toBe("season/index.json");
    expect(seasonObjectKey(["tift", "2026-10-20.json"])).toBe("season/tift/2026-10-20.json");
    expect(seasonObjectKey(["unknown", "2026-10-20.json"])).toBeUndefined();
    expect(seasonObjectKey(["tift", "2026-02-30.json"])).toBeUndefined();
    expect(seasonObjectKey(["tift", "..", "index.json"])).toBeUndefined();
  });

  test("returns 503 without credentials and does not call S3", async () => {
    vi.stubEnv("SEASON_READ_SECRET", "");
    const send = vi.spyOn(S3Client.prototype, "send");
    const response = await GET(new Request("http://localhost/api/season/index.json"), context(["index.json"]));
    expect(response.status).toBe(503);
    expect(send).not.toHaveBeenCalled();
  });

  test("reads an exact JSON key with a five minute CDN cache", async () => {
    const payload = Buffer.from('{"points":{"tift":{}}}');
    const send = vi.spyOn(S3Client.prototype, "send").mockResolvedValue({
      Body: { transformToByteArray: async () => payload },
    } as never);
    const response = await GET(
      new Request("http://localhost/api/season/tift/2026-10-20.json"),
      context(["tift", "2026-10-20.json"]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=60");
    expect(await response.json()).toEqual({ points: { tift: {} } });
    expect(send.mock.calls[0][0]).toMatchObject({
      input: { Bucket: "season-test", Key: "season/tift/2026-10-20.json" },
    });
  });

  test("maps a missing object to not recorded", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue({
      name: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    const response = await GET(
      new Request("http://localhost/api/season/tift/2026-10-20.json"),
      context(["tift", "2026-10-20.json"]),
    );
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("not found");
  });
});
