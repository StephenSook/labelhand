import {
  callStrictJson,
  mergeUsage,
  TokenFactoryError,
  type TokenFactoryOptions,
  type TokenUsage,
} from "./compiler/token-factory";
import { assertFederalReg, listLabelVersions, PplsError, type PplsProduct } from "./ppls";

export const PHOTO_MODEL = "nvidia/Nemotron-3.5-Super-VL";
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
export const PHOTO_MAX_TOKENS = 220;

const GENERIC_NAME_TOKENS = new Set([
  "aid",
  "and",
  "brand",
  "boll",
  "cotton",
  "defoliant",
  "ethephon",
  "flowable",
  "fungicide",
  "harvest",
  "herbicide",
  "insect",
  "insecticide",
  "control",
  "opener",
  "for",
  "product",
  "the",
  "technology",
  "tobacco",
  "with",
  "xemium",
  "zeon",
]);

const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    epa_reg_no: { type: ["string", "null"], maxLength: 24 },
    product_name: { type: ["string", "null"], maxLength: 160 },
    readable: { type: "boolean" },
    what_is_visible: { type: "string", maxLength: 400 },
  },
  required: ["epa_reg_no", "product_name", "readable", "what_is_visible"],
  additionalProperties: false,
};

const PHOTO_SYSTEM_PROMPT = `Read the printed pesticide container label in the image.
Return only the requested JSON. Copy the EPA registration number exactly as printed after "EPA Reg. No." and keep its hyphens.
Copy the printed product name. Read only visible printed text. Never infer, complete, repair, or guess a digit.
If every digit of the registration number is not legible, set epa_reg_no to null and readable to false.
Do not report a confidence score.`;

export type PhotoMime = "image/jpeg" | "image/png";
export type PhotoVerdict = "MATCHED" | "NAME_DIFFERS" | "NOT_FOUND" | "UNREADABLE";

export interface PhotoModelReading {
  epa_reg_no: string | null;
  product_name: string | null;
  readable: boolean;
  what_is_visible: string;
}

export interface PhotoReadResult {
  verdict: PhotoVerdict;
  epa_reg_no: string | null;
  read_epa_reg_no: string | null;
  model_product_name: string | null;
  epa_product_name: string | null;
  alternate_brand_names: string[];
  readable: boolean;
  what_is_visible: string;
  name_agrees: boolean | null;
  model: string;
  latency_ms: number;
  usage: TokenUsage;
  request_ids: string[];
}

export interface ReadLabelPhotoOptions {
  apiKey: string;
  tokenFactoryFetch?: typeof fetch;
  pplsFetch?: typeof fetch;
  signal?: AbortSignal;
  sleep?: TokenFactoryOptions["sleep"];
  onUsage?: TokenFactoryOptions["onUsage"];
  lookupProduct?: (reg: string) => Promise<PplsProduct>;
}

export class PhotoReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly usage: TokenUsage,
    readonly requestIds: string[],
    readonly diagnostic: {
      source: "token_factory" | "ppls" | "internal";
      upstreamStatus?: number;
      detail: string;
    },
  ) {
    super(message);
    this.name = "PhotoReadError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown, maximum: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed || null : undefined;
}

export function validatePhotoModelReading(value: unknown): PhotoModelReading {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "epa_reg_no,product_name,readable,what_is_visible") {
    throw new TokenFactoryError("The label photo reader returned an invalid object.");
  }
  const epaRegNo = nullableString(value.epa_reg_no, 24);
  const productName = nullableString(value.product_name, 160);
  if (epaRegNo === undefined || productName === undefined || typeof value.readable !== "boolean") {
    throw new TokenFactoryError("The label photo reader returned invalid field types.");
  }
  if (typeof value.what_is_visible !== "string" || value.what_is_visible.trim().length > 400) {
    throw new TokenFactoryError("The label photo reader returned an invalid visibility description.");
  }
  return {
    epa_reg_no: epaRegNo,
    product_name: productName,
    readable: value.readable,
    what_is_visible: value.what_is_visible.trim(),
  };
}

export function detectPhotoMime(bytes: Uint8Array): PhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte) ? "image/png" : null;
}

export function productNameTokens(value: string): string[] {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .toLowerCase();
  return [...new Set(normalized.match(/[a-z0-9]+/g) ?? [])]
    .filter((token) => !GENERIC_NAME_TOKENS.has(token));
}

export function productNamesAgree(readName: string | null, candidates: string[]): boolean {
  if (!readName) return false;
  const readTokens = productNameTokens(readName);
  if (readTokens.length === 0) return false;
  return candidates.some((candidate) => {
    const candidateTokens = productNameTokens(candidate);
    if (candidateTokens.length === 0) return false;
    const candidateSet = new Set(candidateTokens);
    if (readTokens.length === candidateTokens.length
      && readTokens.every((token) => candidateSet.has(token))) return true;
    const shared = readTokens.filter((token) => candidateSet.has(token));
    const unionSize = new Set([...readTokens, ...candidateTokens]).size;
    return shared.some((token) => /^[a-z]{4,}$/.test(token))
      && shared.length / unionSize >= 0.6;
  });
}

function baseResult(reading: PhotoModelReading, usage: TokenUsage, latencyMs: number, requestIds: string[]) {
  return {
    read_epa_reg_no: reading.epa_reg_no,
    model_product_name: reading.product_name,
    readable: reading.readable,
    what_is_visible: reading.what_is_visible,
    model: PHOTO_MODEL,
    latency_ms: latencyMs,
    usage,
    request_ids: requestIds,
  };
}

export async function verifyPhotoReading(
  reading: PhotoModelReading,
  measurement: { usage: TokenUsage; latencyMs: number; requestIds: string[] },
  lookupProduct: (reg: string) => Promise<PplsProduct>,
): Promise<PhotoReadResult> {
  const common = baseResult(reading, measurement.usage, measurement.latencyMs, measurement.requestIds);
  if (!reading.readable || !reading.epa_reg_no) {
    return {
      ...common,
      verdict: "UNREADABLE",
      epa_reg_no: null,
      epa_product_name: null,
      alternate_brand_names: [],
      name_agrees: null,
    };
  }

  let reg: string;
  try {
    reg = assertFederalReg(reading.epa_reg_no);
  } catch {
    return {
      ...common,
      verdict: "UNREADABLE",
      epa_reg_no: null,
      epa_product_name: null,
      alternate_brand_names: [],
      name_agrees: null,
    };
  }

  let product: PplsProduct;
  try {
    product = await lookupProduct(reg);
  } catch (error) {
    if (error instanceof PplsError && error.status === 404) {
      return {
        ...common,
        verdict: "NOT_FOUND",
        epa_reg_no: null,
        epa_product_name: null,
        alternate_brand_names: [],
        name_agrees: null,
      };
    }
    throw error;
  }

  const agrees = productNamesAgree(reading.product_name, [product.product, ...product.alternateBrandNames]);
  return {
    ...common,
    verdict: agrees ? "MATCHED" : "NAME_DIFFERS",
    epa_reg_no: reg,
    epa_product_name: product.product,
    alternate_brand_names: product.alternateBrandNames,
    name_agrees: agrees,
  };
}

export async function readLabelPhoto(
  bytes: Uint8Array,
  mime: PhotoMime,
  options: ReadLabelPhotoOptions,
): Promise<PhotoReadResult> {
  if (bytes.byteLength > MAX_PHOTO_BYTES) throw new RangeError("The label photo exceeds 4 MB.");
  if (detectPhotoMime(bytes) !== mime) throw new TypeError("The label photo signature does not match its image type.");

  const observedUsage: TokenUsage[] = [];
  const requestIds: string[] = [];
  const started = performance.now();
  try {
    const result = await callStrictJson<unknown>({
      model: PHOTO_MODEL,
      system: PHOTO_SYSTEM_PROMPT,
      user: [
        { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } },
        { type: "text", text: "Read this pesticide label image." },
      ],
      schemaName: "label_photo_read",
      schema: PHOTO_SCHEMA,
      maxTokens: PHOTO_MAX_TOKENS,
    }, {
      apiKey: options.apiKey,
      fetchImpl: options.tokenFactoryFetch,
      signal: options.signal,
      sleep: options.sleep,
      onUsage: (usage, requestId) => {
        observedUsage.push(usage);
        if (requestId) requestIds.push(requestId);
        options.onUsage?.(usage, requestId);
      },
    });
    const reading = validatePhotoModelReading(result.value);
    const lookupProduct = options.lookupProduct
      ?? ((reg: string) => listLabelVersions(reg, options.pplsFetch));
    const verified = await verifyPhotoReading(reading, {
      usage: mergeUsage(...observedUsage),
      latencyMs: 0,
      requestIds,
    }, lookupProduct);
    return { ...verified, latency_ms: Math.round(performance.now() - started) };
  } catch (error) {
    const billedUsage = mergeUsage(...observedUsage);
    if (error instanceof PplsError) {
      throw new PhotoReadError(error.message, error.status, billedUsage, requestIds, {
        source: "ppls",
        upstreamStatus: error.status,
        detail: error.message,
      });
    }
    if (error instanceof TokenFactoryError) {
      const status = error.status === 429
        ? 429
        : error.status === 401 || error.status === 402 || error.status === 403
          ? 503
          : 502;
      const message = error.status === 402
        ? "Token Factory credit is exhausted."
        : error.status === 429
          ? "Token Factory is busy. Try again shortly."
          : error.status === 401 || error.status === 403
            ? "Token Factory credentials are unavailable."
            : error.status === 400 || error.status === 404 || error.status === 422
              ? "Token Factory rejected the label photo request."
              : error.status !== undefined && error.status >= 500
                ? "Token Factory is unavailable."
                : "Token Factory returned invalid label photo data.";
      throw new PhotoReadError(message, status, billedUsage, requestIds, {
        source: "token_factory",
        ...(error.status !== undefined ? { upstreamStatus: error.status } : {}),
        detail: error.message,
      });
    }
    if (options.signal?.aborted) {
      throw new PhotoReadError("The label photo read deadline was reached.", 504, billedUsage, requestIds, {
        source: "internal",
        detail: options.signal.reason instanceof Error ? options.signal.reason.message : "request aborted",
      });
    }
    throw new PhotoReadError("Label photo reading failed.", 502, billedUsage, requestIds, {
      source: "internal",
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown failure",
    });
  }
}
