import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractPdfText } from "../src/lib/compiler/pdf-text";
import {
  PHOTO_MODEL,
  PhotoReadError,
  productNameTokens,
  readLabelPhoto,
  type PhotoReadResult,
} from "../src/lib/photo-reading";
import { fetchLabelPdf, listLabelVersions } from "../src/lib/ppls";

const MODEL_LIST_ENDPOINT = "https://api.tokenfactory.nebius.com/v1/models";
const OUTPUT = path.resolve(process.cwd(), "..", "eval", "results", "photo-read-2026-10-19.json");
const BUDGET_USD = 2;
const PRIOR_PAID_RUNS = [
  { cost_usd: 0.0277878, outcome: "38 completed, 2 truncated at 220 output tokens" },
  { cost_usd: 0.0274836, outcome: "40 completed; superseded because one selected page was an EPA acceptance letter" },
  { cost_usd: 0.0274623, outcome: "40 completed; superseded because the selected Warrant master-label page did not print the product name" },
] as const;
const PRIOR_PAID_SPEND_USD = PRIOR_PAID_RUNS.reduce((sum, run) => sum + run.cost_usd, 0);

const MANIFEST = [
  {
    reg: "5481-504",
    expectedName: "Folex 6 EC",
    category: "defoliant",
    required: true,
    frontPage: 3,
    registrationSide: "right",
  },
  { reg: "264-700", expectedName: "Dropp SC", category: "defoliant", required: true },
  { reg: "264-418", expectedName: "Prep", category: "defoliant", required: true },
  { reg: "100-1256", expectedName: "Axial XL", category: "herbicide", required: true },
  {
    reg: "264-802",
    expectedName: "Osprey",
    category: "herbicide",
    required: true,
    frontPage: 3,
  },
  { reg: "62719-643", expectedName: "PowerFlex HL", category: "herbicide", required: true },
  { reg: "279-9583", expectedName: "Harmony Extra SG", category: "herbicide", required: true },
  { reg: "100-816", expectedName: "Dual Magnum", category: "herbicide", required: false },
  { reg: "7969-448", expectedName: "Liberty 280 SL", category: "herbicide", required: false },
  { reg: "5481-684", expectedName: "Envoke", category: "herbicide", required: false },
  {
    reg: "352-613",
    expectedName: "Staple LX",
    category: "herbicide",
    required: false,
    frontPage: 3,
  },
  { reg: "8033-36", expectedName: "Assail 30 SG", category: "insecticide", required: false },
  {
    reg: "62719-625",
    expectedName: "Transform WG",
    category: "insecticide",
    required: false,
    frontPage: 3,
  },
  { reg: "279-9656", expectedName: "Vantacor", category: "insecticide", required: false },
  { reg: "100-1295", expectedName: "Warrior II", category: "insecticide", required: false },
  { reg: "264-862", expectedName: "Provost Silver", category: "fungicide", required: false },
  { reg: "352-834", expectedName: "Fontelis", category: "fungicide", required: false },
  {
    reg: "7969-186",
    expectedName: "Headline",
    category: "fungicide",
    required: false,
    frontPage: 3,
  },
  { reg: "7969-311", expectedName: "Priaxor", category: "fungicide", required: false },
  { reg: "100-1098", expectedName: "Abound", category: "fungicide", required: false },
] as const;

type SetKey = "rendered_label_pages" | "simulated_phone_degradation";

interface PreparedImage {
  set: SetKey;
  setLabel: string;
  path: string;
  sha256: string;
  bytes: number;
  transform: Record<string, unknown>;
}

interface RenderTools {
  pdftoppm: string;
  pdftotext: string;
}

interface ImageResult {
  reg_truth: string;
  expected_product_name: string;
  category: string;
  required_product: boolean;
  ppls_product_name: string;
  alternate_brand_names: string[];
  label_accepted: string;
  label_url: string;
  label_sha256: string;
  front_panel_page: number;
  set: SetKey;
  set_label: string;
  image_sha256: string;
  image_bytes: number;
  transform: Record<string, unknown>;
  status: "completed" | "failed";
  read_epa_reg_no?: string | null;
  exact_reg_match?: boolean;
  verdict?: string;
  model_product_name?: string | null;
  epa_product_name?: string | null;
  product_name_agrees?: boolean | null;
  readable?: boolean;
  what_is_visible?: string;
  latency_ms?: number;
  usage?: PhotoReadResult["usage"];
  request_ids?: string[];
  error?: string;
  error_status?: number;
  error_diagnostic?: PhotoReadError["diagnostic"];
}

interface EvalResult {
  schema_version: number;
  evaluation: string;
  data_description: string;
  run: {
    status: "checking_model" | "preparing" | "running" | "complete" | "failed" | "budget_stopped";
    started_utc: string;
    finished_utc: string | null;
    budget_usd: number;
    stop_reason: string | null;
    prior_paid_runs: Array<{ cost_usd: number; outcome: string }>;
    current_run_cost_usd: number;
    total_session_cost_usd: number;
  };
  model_availability: Record<string, unknown>;
  pricing: Record<string, unknown>;
  input_sets: Record<string, unknown>;
  manifest: Array<Record<string, unknown>>;
  labels: Array<Record<string, unknown>>;
  images: ImageResult[];
  pooled: Record<string, unknown>;
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function persist(result: EvalResult): Promise<void> {
  await writeFile(OUTPUT, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

async function command(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${executable} exited ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

async function renderTools(): Promise<RenderTools> {
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const located = await command(locator, ["pdftoppm"]);
  const pdftoppm = located.split(/\r?\n/).map((item) => item.trim()).find(Boolean);
  if (!pdftoppm) throw new Error("pdftoppm was not found.");
  const suffix = process.platform === "win32" ? ".exe" : "";
  return { pdftoppm, pdftotext: path.join(path.dirname(pdftoppm), `pdftotext${suffix}`) };
}

function pageContainsProductAndReg(text: string, expectedName: string): boolean {
  const pageTokens = new Set(productNameTokens(text));
  const nameTokens = productNameTokens(expectedName);
  const hasName = nameTokens.length > 0 && nameTokens.every((token) => pageTokens.has(token));
  const hasReg = /\bEPA\s+(?:REG|REGISTRATION)/i.test(text);
  const hasFrontPanelMarker = /\b(?:ACTIVE\s+INGREDIENTS?|KEEP\s+OUT\s+OF\s+REACH)\b/i.test(text);
  return hasName && hasReg && hasFrontPanelMarker;
}

function frontPanelPage(pages: string[], candidates: string[]): { page: number; matchedName: string } {
  for (const candidate of candidates.filter(Boolean)) {
    const index = pages.findIndex((text) => pageContainsProductAndReg(text, candidate));
    if (index >= 0) return { page: index + 1, matchedName: candidate };
  }
  throw new Error(`No page contained both a product name and EPA Reg text for candidates: ${candidates.join(", ")}.`);
}

function selectFrontPanel(
  pages: string[],
  candidates: string[],
  manualPage?: number,
): { page: number; matchedName: string; selection: "text_match" | "manual_visual_image_text" } {
  if (manualPage === undefined) {
    return { ...frontPanelPage(pages, candidates), selection: "text_match" };
  }
  if (!pages[manualPage - 1]) {
    throw new Error(`Visually selected page ${manualPage} is outside the PDF.`);
  }
  return { page: manualPage, matchedName: candidates[0], selection: "manual_visual_image_text" };
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function registrationCenterX(bbox: string, reg: string): { x: number; pageWidth: number } {
  const pageWidth = Number(/<page\s+width="([0-9.]+)"/.exec(bbox)?.[1]);
  const words = [...bbox.matchAll(/<word\s+xMin="([0-9.]+)"\s+yMin="[0-9.]+"\s+xMax="([0-9.]+)"\s+yMax="[0-9.]+">([^<]*)<\/word>/g)]
    .map((match) => ({ xMin: Number(match[1]), xMax: Number(match[2]), text: decodeXml(match[3]) }));
  const normalizedReg = reg.replace(/\D/g, "");
  for (let start = 0; start < words.length; start += 1) {
    let joined = "";
    for (let end = start; end < Math.min(words.length, start + 4); end += 1) {
      joined += words[end].text.replace(/\D/g, "");
      if (joined === normalizedReg && Number.isFinite(pageWidth)) {
        return { x: (words[start].xMin + words[end].xMax) / 2, pageWidth };
      }
      if (!normalizedReg.startsWith(joined)) break;
    }
  }
  throw new Error(`Could not locate ${reg} in the front-panel PDF text coordinates.`);
}

async function renderImages(
  temp: string,
  reg: string,
  pdfBytes: Uint8Array,
  page: number,
  tools: RenderTools,
  registrationSide?: "left" | "right",
): Promise<PreparedImage[]> {
  const pdfPath = path.join(temp, `${reg}.pdf`);
  const baseRoot = path.join(temp, `${reg}-page-${page}`);
  const basePath = `${baseRoot}.jpg`;
  const hardPath = path.join(temp, `${reg}-page-${page}-degraded.jpg`);
  await writeFile(pdfPath, pdfBytes);
  await command(tools.pdftoppm, [
    "-f", String(page),
    "-l", String(page),
    "-singlefile",
    "-jpeg",
    "-scale-to", "1600",
    "-jpegopt", "quality=90",
    pdfPath,
    baseRoot,
  ]);
  const bbox = await command(tools.pdftotext, ["-f", String(page), "-l", String(page), "-bbox-layout", pdfPath, "-"]);
  const position = registrationSide ? null : registrationCenterX(bbox, reg);
  const retainedEdge = registrationSide
    ? registrationSide === "right" ? "East" : "West"
    : position!.x >= position!.pageWidth / 2 ? "East" : "West";
  await command("magick", [
    basePath,
    "-background", "white",
    "-rotate", "4",
    "-gravity", retainedEdge,
    "-crop", "94%x100%+0+0",
    "+repage",
    "-resize", "1600x1600>",
    "-quality", "55",
    hardPath,
  ]);
  const base = await readFile(basePath);
  const hard = await readFile(hardPath);
  return [
    {
      set: "rendered_label_pages",
      setLabel: "rendered label pages",
      path: basePath,
      sha256: sha256(base),
      bytes: base.byteLength,
      transform: { source: "newest accepted EPA PPLS PDF", page, long_side_px: 1600, jpeg_quality: 90 },
    },
    {
      set: "simulated_phone_degradation",
      setLabel: "rendered pages with simulated phone degradation",
      path: hardPath,
      sha256: sha256(hard),
      bytes: hard.byteLength,
      transform: {
        source: "rendered label page",
        rotation_degrees: 4,
        crop_percent: 6,
        cropped_edge: retainedEdge === "East" ? "left" : "right",
        epa_reg_retained_edge: retainedEdge.toLowerCase(),
        long_side_px: 1600,
        jpeg_quality: 55,
      },
    },
  ];
}

function summarize(images: ImageResult[]) {
  const completed = images.filter((image) => image.status === "completed");
  const summaryFor = (selected: ImageResult[]) => {
    const exact = selected.filter((image) => image.exact_reg_match).length;
    const nameAgrees = selected.filter((image) => image.product_name_agrees === true).length;
    const verdictCounts: Record<string, number> = {};
    for (const image of selected) {
      const verdict = image.verdict ?? "FAILED";
      verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
    }
    return {
      images: selected.length,
      exact_reg_reads: exact,
      exact_reg_read_rate: selected.length ? round(exact / selected.length) : 0,
      product_name_agreements: nameAgrees,
      product_name_agreement_rate: selected.length ? round(nameAgrees / selected.length) : 0,
      verdict_counts: verdictCounts,
      latency_ms: {
        total: selected.reduce((sum, image) => sum + (image.latency_ms ?? 0), 0),
        mean: selected.length ? round(selected.reduce((sum, image) => sum + (image.latency_ms ?? 0), 0) / selected.length, 3) : 0,
      },
      tokens: {
        input: selected.reduce((sum, image) => sum + (image.usage?.inputTokens ?? 0), 0),
        output: selected.reduce((sum, image) => sum + (image.usage?.outputTokens ?? 0), 0),
        total: selected.reduce((sum, image) => sum + (image.usage?.totalTokens ?? 0), 0),
      },
      cost_usd: round(selected.reduce((sum, image) => sum + (image.usage?.costUsd ?? 0), 0), 8),
    };
  };
  const wrongButValid = completed.filter((image) => image.read_epa_reg_no !== image.reg_truth
    && image.read_epa_reg_no !== null
    && image.verdict !== "NOT_FOUND"
    && image.verdict !== "UNREADABLE");
  return {
    labels_evaluated: MANIFEST.length,
    expected_images: MANIFEST.length * 2,
    completed_images: completed.length,
    failed_images: images.length - completed.length,
    sets: {
      rendered_label_pages: summaryFor(images.filter((image) => image.set === "rendered_label_pages")),
      simulated_phone_degradation: summaryFor(images.filter((image) => image.set === "simulated_phone_degradation")),
    },
    overall: summaryFor(images),
    wrong_but_valid_reg_reads: wrongButValid.length,
    wrong_but_valid_cases: wrongButValid.map((image) => ({
      truth: image.reg_truth,
      read: image.read_epa_reg_no,
      set: image.set_label,
      verdict: image.verdict,
    })),
  };
}

async function checkModel(apiKey: string): Promise<Record<string, unknown>> {
  const checkedUtc = new Date().toISOString();
  const response = await fetch(MODEL_LIST_ENDPOINT, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  const payload = await response.json() as { data?: Array<Record<string, unknown>> };
  const models = Array.isArray(payload.data) ? payload.data : [];
  const matched = models.find((model) => model.id === PHOTO_MODEL) ?? null;
  return {
    checked_utc: checkedUtc,
    endpoint: MODEL_LIST_ENDPOINT,
    http_status: response.status,
    model: PHOTO_MODEL,
    model_present: response.ok && matched !== null,
    model_count: models.length,
    matched_model: matched,
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.NEBIUS_API_KEY?.trim();
  if (!apiKey) throw new Error("NEBIUS_API_KEY is required.");
  const result: EvalResult = {
    schema_version: 1,
    evaluation: "EPA registration reading from rendered pesticide label pages",
    data_description: "These inputs are rendered label pages and rendered pages with simulated phone degradation. They are not photos.",
    run: {
      status: "checking_model",
      started_utc: new Date().toISOString(),
      finished_utc: null,
      budget_usd: BUDGET_USD,
      stop_reason: null,
      prior_paid_runs: PRIOR_PAID_RUNS.map((run) => ({ ...run })),
      current_run_cost_usd: 0,
      total_session_cost_usd: round(PRIOR_PAID_SPEND_USD, 8),
    },
    model_availability: {},
    pricing: {
      model: PHOTO_MODEL,
      input_usd_per_million_tokens: 0.30,
      output_usd_per_million_tokens: 0.90,
      source: "https://nebius.com/blog/posts/three-new-open-weight-models-from-us-companies-give-builders-more-choice",
    },
    input_sets: {
      rendered_label_pages: {
        images: MANIFEST.length,
        source: "newest accepted EPA PPLS PDF front-panel page",
        long_side_px: 1600,
        jpeg_quality: 90,
      },
      simulated_phone_degradation: {
        images: MANIFEST.length,
        source: "same rendered label page",
        rotation_degrees: 4,
        crop_percent: 6,
        crop_rule: "crop the edge opposite the registration number",
        long_side_px: 1600,
        jpeg_quality: 55,
      },
    },
    manifest: MANIFEST.map((item) => ({ ...item })),
    labels: [],
    images: [],
    pooled: {},
  };
  await persist(result);
  result.model_availability = await checkModel(apiKey);
  if (result.model_availability.model_present !== true) {
    result.run.status = "failed";
    result.run.stop_reason = `${PHOTO_MODEL} was not available from GET /v1/models.`;
    result.run.finished_utc = new Date().toISOString();
    await persist(result);
    return;
  }

  const temp = await mkdtemp(path.join(tmpdir(), "labelhand-photo-eval-"));
  try {
    result.run.status = "preparing";
    await persist(result);
    const tools = await renderTools();
    const prepared: Array<{
      item: (typeof MANIFEST)[number];
      product: Awaited<ReturnType<typeof listLabelVersions>>;
      version: Awaited<ReturnType<typeof listLabelVersions>>["versions"][number];
      pdfSha256: string;
      page: number;
      frontPanelMatchedName: string;
      images: PreparedImage[];
    }> = [];
    for (const item of MANIFEST) {
      const product = await listLabelVersions(item.reg);
      const version = product.versions[0];
      const pdf = await fetchLabelPdf(version);
      const extracted = await extractPdfText(pdf.bytes.slice());
      const frontPanel = selectFrontPanel(
        extracted.pages,
        [item.expectedName, product.product, ...product.alternateBrandNames],
        "frontPage" in item ? item.frontPage : undefined,
      );
      const images = await renderImages(
        temp,
        item.reg,
        pdf.bytes,
        frontPanel.page,
        tools,
        "registrationSide" in item ? item.registrationSide : undefined,
      );
      prepared.push({
        item,
        product,
        version,
        pdfSha256: pdf.sha256,
        page: frontPanel.page,
        frontPanelMatchedName: frontPanel.matchedName,
        images,
      });
      result.labels.push({
        reg: item.reg,
        expected_product_name: item.expectedName,
        category: item.category,
        ppls_product_name: product.product,
        alternate_brand_names: product.alternateBrandNames,
        status: product.status,
        newest_accepted: version.accepted,
        newest_url: version.url,
        pdf_sha256: pdf.sha256,
        pdf_bytes: pdf.byteLength,
        front_panel_page: frontPanel.page,
        front_panel_matched_name: frontPanel.matchedName,
        front_panel_selection: frontPanel.selection,
      });
      await persist(result);
      process.stdout.write(`prepared ${item.reg} page ${frontPanel.page}\n`);
    }

    result.run.status = "running";
    await persist(result);
    let spend = 0;
    for (const entry of prepared) {
      for (const image of entry.images) {
        if (spend >= BUDGET_USD) {
          result.run.status = "budget_stopped";
          result.run.stop_reason = `Measured spend reached USD ${spend.toFixed(8)} before all calls completed.`;
          break;
        }
        const bytes = await readFile(image.path);
        const common = {
          reg_truth: entry.item.reg,
          expected_product_name: entry.item.expectedName,
          category: entry.item.category,
          required_product: entry.item.required,
          ppls_product_name: entry.product.product,
          alternate_brand_names: entry.product.alternateBrandNames,
          label_accepted: entry.version.accepted,
          label_url: entry.version.url,
          label_sha256: entry.pdfSha256,
          front_panel_page: entry.page,
          set: image.set,
          set_label: image.setLabel,
          image_sha256: image.sha256,
          image_bytes: image.bytes,
          transform: image.transform,
        };
        try {
          const read = await readLabelPhoto(bytes, "image/jpeg", { apiKey });
          spend += read.usage.costUsd;
          result.images.push({
            ...common,
            status: "completed",
            read_epa_reg_no: read.read_epa_reg_no,
            exact_reg_match: read.read_epa_reg_no === entry.item.reg,
            verdict: read.verdict,
            model_product_name: read.model_product_name,
            epa_product_name: read.epa_product_name,
            product_name_agrees: read.name_agrees,
            readable: read.readable,
            what_is_visible: read.what_is_visible,
            latency_ms: read.latency_ms,
            usage: read.usage,
            request_ids: read.request_ids,
          });
        } catch (error) {
          if (error instanceof PhotoReadError) spend += error.usage.costUsd;
          result.images.push({
            ...common,
            status: "failed",
            ...(error instanceof PhotoReadError ? {
              usage: error.usage,
              request_ids: error.requestIds,
              error_status: error.status,
              error_diagnostic: error.diagnostic,
            } : {}),
            error: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error",
          });
          if (error instanceof PhotoReadError
            && error.diagnostic.source === "token_factory"
            && [401, 402, 403].includes(error.diagnostic.upstreamStatus ?? 0)) {
            result.run.status = "failed";
            result.run.stop_reason = error.message;
          }
        }
        result.pooled = summarize(result.images);
        result.run.current_run_cost_usd = round(spend, 8);
        result.run.total_session_cost_usd = round(PRIOR_PAID_SPEND_USD + spend, 8);
        await persist(result);
        const latest = result.images.at(-1);
        process.stdout.write(`${entry.item.reg} ${image.set}: ${latest?.status} ${latest?.read_epa_reg_no ?? "null"} USD ${spend.toFixed(8)}\n`);
        if (result.run.status === "failed") break;
      }
      if (result.run.status !== "running") break;
    }
    if (result.run.status === "running") {
      result.run.status = result.images.length === MANIFEST.length * 2 ? "complete" : "failed";
      if (result.run.status === "failed") result.run.stop_reason = "The run ended before all 40 images were recorded.";
    }
    result.pooled = summarize(result.images);
    result.run.finished_utc = new Date().toISOString();
    await persist(result);
  } catch (error) {
    result.run.status = "failed";
    result.run.stop_reason = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
    result.run.finished_utc = new Date().toISOString();
    result.pooled = summarize(result.images);
    await persist(result);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

await main();
