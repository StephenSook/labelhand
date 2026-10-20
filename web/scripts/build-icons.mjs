// Renders the Labelhand mark to the PNG app icons the web manifest names.
//   node scripts/build-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
mkdirSync(out, { recursive: true });

// The same paths as src/ui/Mark.tsx, with the theme colors filled in.
const mark = `
  <path d="M13 8h38l10 10v34H13z" fill="#fbf7ee" stroke="#14213d" stroke-linejoin="round" stroke-width="3.5"/>
  <path d="M51 8v10h10" fill="#9fd3f2" stroke="#14213d" stroke-linejoin="round" stroke-width="3.5"/>
  <path d="m23 31 7 7 14-16" fill="none" stroke="#2f8f4e" stroke-linecap="round" stroke-linejoin="round" stroke-width="5"/>
  <path d="M4 49c16-7 39-7 64 1" fill="none" stroke="#8a5a2b" stroke-linecap="round" stroke-width="4"/>
  <circle cx="7" cy="48" fill="#ffc53d" r="3" stroke="#14213d" stroke-width="2"/>
  <circle cx="65" cy="50" fill="#ffc53d" r="3" stroke="#14213d" stroke-width="2"/>`;

// "any" icons sit on a rounded sky tile; the maskable one keeps the mark inside the 80% safe zone.
function svg(size, maskable) {
  const scale = maskable ? 0.6 : 0.78;
  const w = 72 * scale * (size / 72);
  const x = (size - w) / 2;
  const y = (size - w * (64 / 72)) / 2;
  const radius = maskable ? 0 : size * 0.22;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${radius}" fill="#9fd3f2"/>
    <g transform="translate(${x} ${y}) scale(${w / 72})">${mark}</g>
  </svg>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, maskable] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["icon-maskable-512.png", 512, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, maskable)}</body></html>`);
  writeFileSync(join(out, name), await page.locator("svg").screenshot({ omitBackground: true }));
  console.log(name);
}
writeFileSync(join(out, "icon.svg"), svg(512, false));
await browser.close();
