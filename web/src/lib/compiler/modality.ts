import { norm, squash } from "./guards";
import spec from "./spec.generated.json";

export type ModalityRule = Record<string, unknown> & {
  modality?: string;
  page: number;
  param?: string;
  quote?: string;
};

export const MODALITY_FLOOR_SOURCE = spec.VERSIONS.floor_source;

const topicParameters = new Set(Object.keys(spec.TOPIC));
const suggestiveWords = /\b(should|may|might|ideally|preferably|preferred|optional)\b/;
const suggestiveStems = ["recommend", "suggest", "optimum", "optimal", "bestresults", "forbest"];
const prohibition = /\b(do not|don't|must not|shall not|never)\b/;
const directive = /\b(must|shall)\b/;
const verbs = [
  "use", "apply", "spray", "mix", "add", "wait", "allow", "keep", "remove", "maintain", "select",
  "make", "begin", "observe", "follow", "calibrate", "adjust", "read", "wear", "rinse", "clean",
  "notify", "check", "monitor", "limit", "restrict", "treat", "incorporate", "defoliate", "release",
  "hold", "delay", "consult", "agitate", "fill", "leave", "postpone", "stop", "cease", "wash",
  "store", "dispose",
].join("|");
const opening = new RegExp(`^(?:only\\s+|always\\s+|then\\s+)?(?:${verbs})\\b(?!\\s+of\\b)`);
const condition = /^(when|if|where|before|after|unless|once|while|until)\b/;
const mainClause = new RegExp(`(?:,|\\d|\\bf\\b|%|\\)|\\bmph\\b|\\binches\\b|\\bfeet\\b|\\bhours?\\b|\\bdays?\\b)\\s+(?:only\\s+)?(?:${verbs})\\b(?!\\s+of\\b)`);
const applicationVerbs = /\b(apply|applying|applied|application|applications|spray|release|treat)\b/;
const advisoryHeading = /advisor|recommendation/;
const advisorySubheadings = [
  "the applicator is responsible",
  "importance of droplet size",
  "controlling droplet size",
  "boom height",
  "boom length",
  "release height",
  "application height",
  "swath adjustment",
  "shielded sprayers",
  "temperature and humidity",
  "temperature inversions",
  "wind",
  "sensitive areas",
  "volume",
  "pressure",
  "nozzle",
  "number of nozzles",
  "adjust nozzles",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.;!?])\s+/)
    .map((sentence) => sentence.replace(/^[ -*:]+|[ -*:]+$/g, ""))
    .filter(Boolean);
}

export function suggestive(sentence: string): boolean {
  const flat = squash(sentence);
  return suggestiveWords.test(sentence) || suggestiveStems.some((stem) => flat.includes(stem));
}

export function gatesApplication(sentence: string, brand: string | null): boolean {
  if (applicationVerbs.test(sentence)) return true;
  const targets = ["this product", "the product", ...(brand ? [brand] : [])];
  return targets.some((target) => new RegExp(`\\buse\\s+(?:only\\s+)?${escapeRegExp(target)}\\b`).test(sentence));
}

export function floorOf(quote: string, brand: string | null = null): "MUST" | "MUST_NOT" | null {
  let best: "MUST" | null = null;
  for (const sentence of sentences(norm(quote).replaceAll("\u00B0", " "))) {
    if (suggestive(sentence)) continue;
    if (prohibition.test(sentence)) return "MUST_NOT";
    const isDirective = directive.test(sentence)
      || opening.test(sentence)
      || (condition.test(sentence) && mainClause.test(sentence));
    if (isDirective && gatesApplication(sentence, brand)) best = "MUST";
  }
  return best;
}

export function isHeading(line: string): boolean {
  const value = line.trim();
  const letters = Array.from(value).filter((character) => /\p{L}/u.test(character));
  const uppercase = letters.filter((character) => character === character.toUpperCase() && character !== character.toLowerCase());
  return letters.length >= 4 && value.length <= 90 && uppercase.length >= 0.9 * letters.length;
}

export function inAdvisorySection(pages: string[], pageNo: number, quote: string): boolean | null {
  let advisory = false;
  const target = squash(norm(quote)).slice(0, 60);
  for (let pageIndex = 0; pageIndex < pages.slice(0, pageNo).length; pageIndex += 1) {
    let lines = pages[pageIndex].split(/\r?\n/);
    if (pageIndex + 1 === pageNo) {
      const flattened = lines.map((line) => squash(norm(line)));
      const at = flattened.join("").indexOf(target);
      if (at < 0) return null;
      let end = 0;
      let cut = lines.length;
      for (let index = 0; index < flattened.length; index += 1) {
        end += flattened[index].length;
        if (end > at) {
          cut = index;
          break;
        }
      }
      lines = lines.slice(0, cut);
    }
    for (const line of lines) {
      if (!isHeading(line)) continue;
      const heading = norm(line);
      if (advisoryHeading.test(heading)) advisory = true;
      else if (advisory && !advisorySubheadings.some((subheading) => heading.startsWith(subheading))) advisory = false;
    }
  }
  return advisory;
}

export function applyFloor<T extends ModalityRule>(rule: T, pages: string[] | null, brand: string | null): T {
  if (rule.modality !== "ADVISORY" || !rule.param || !topicParameters.has(rule.param)) return rule;
  const floor = floorOf(rule.quote ?? "", brand);
  if (floor === null) return rule;
  const section = pages ? inAdvisorySection(pages, rule.page, rule.quote ?? "") : null;
  if (section !== false) return rule;
  return {
    ...rule,
    modality: floor,
    modality_model: "ADVISORY",
    modality_floor: MODALITY_FLOOR_SOURCE,
  };
}

export function brandOf(product: string): string | null {
  return norm(product).match(/[a-z0-9]+/)?.[0] ?? null;
}
