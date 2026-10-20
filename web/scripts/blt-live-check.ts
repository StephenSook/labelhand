// Asks EPA Bulletins Live! Two live, through the same checker /api/bulletins uses, for the shipped
// tank at every Labelhand field point, plus two products that do carry limitations.
// Run from web/: pnpm exec tsx scripts/blt-live-check.ts [YYYY-MM ...]
import { readFile } from "node:fs/promises";
import path from "node:path";

import { easternMonth } from "../src/lib/bulletins";
import { CONTROL_POINT, CONTROL_REG, checkBulletins } from "../src/lib/blt";

const TANK = ["264-418", "264-700", "5481-504"];
// A point inside PULA 121 (Dicamba 2026) in Dooly County, GA.
const DOOLY_PULA_121 = { lat: 32.21361, lon: -83.73173 };
const LANNATE_LV = "61842-55";

type Point = { name: string; lat: number; lon: number };

async function main() {
  const months = process.argv.slice(2);
  if (months.length === 0) months.push(easternMonth(new Date()));
  const points = JSON.parse(await readFile(path.join(process.cwd(), "public", "data", "nws_points_cache.json"), "utf8")) as Point[];
  const started = new Date().toISOString();
  const tank: Record<string, unknown> = {};
  const elapsed: number[] = [];
  for (const month of months) {
    for (const point of points) {
      const begin = Date.now();
      const answer = await checkBulletins({ lat: point.lat, lon: point.lon, regs: TANK, month }, fetch, new Date());
      elapsed.push(Date.now() - begin);
      tank[`${month} ${point.name}`] = answer.status === "checked"
        ? { status: answer.status, pulas: answer.pulas.map((pula) => pula.pula_id), limitations: answer.limitations.length }
        : answer;
    }
  }
  const positives: Record<string, unknown> = {};
  for (const [label, point, reg] of [
    [`${CONTROL_REG} at Dooly PULA 121 point`, DOOLY_PULA_121, CONTROL_REG],
    [`${LANNATE_LV} at Ware control point`, CONTROL_POINT, LANNATE_LV],
  ] as const) {
    const answer = await checkBulletins({ lat: point.lat, lon: point.lon, regs: [reg], month: months[0] }, fetch, new Date());
    positives[label] = answer.status === "checked"
      ? answer.limitations.map((limitation) => `${limitation.reg} ${limitation.code} PULA ${limitation.pula_id}`)
      : answer;
  }
  const checked = Object.values(tank).filter((answer) => (answer as { status: string }).status === "checked").length;
  console.log(JSON.stringify({
    started,
    finished: new Date().toISOString(),
    tank: { checks: Object.keys(tank).length, checked, ms_min: Math.min(...elapsed), ms_max: Math.max(...elapsed), answers: tank },
    positives,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
