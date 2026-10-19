// Writes public/data/map/south-georgia.json: SVG paths for the Georgia counties around the ten
// forecast points, in a fixed equirectangular frame the map page also uses to place the points.
// County shapes come from us-atlas (US Census cartographic boundaries, 1:10,000,000).
//
//   node scripts/build-county-map.mjs

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const topology = require("us-atlas/counties-10m.json");
const points = JSON.parse(readFileSync(join(web, "public/data/nws_points_cache.json"), "utf8"));

// The frame: a little wider than the ten points, so each county around them shows in full.
const BOUNDS = { west: -84.52, east: -82.58, south: 30.93, north: 32.32 };
const WIDTH = 1000;
const latMid = ((BOUNDS.south + BOUNDS.north) / 2) * (Math.PI / 180);
const scale = WIDTH / ((BOUNDS.east - BOUNDS.west) * Math.cos(latMid));
const HEIGHT = Math.round((BOUNDS.north - BOUNDS.south) * scale);

const project = ([lon, lat]) => [
  (lon - BOUNDS.west) * Math.cos(latMid) * scale,
  (BOUNDS.north - lat) * scale,
];

const round = (value) => Math.round(value * 10) / 10;

function ringPath(ring) {
  return `M${ring.map((position) => project(position).map(round).join(",")).join("L")}Z`;
}

function geometryPath(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((polygon) => polygon.map(ringPath).join("")).join("");
}

function inFrame(geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) =>
    polygon[0].some(([lon, lat]) =>
      lon >= BOUNDS.west && lon <= BOUNDS.east && lat >= BOUNDS.south && lat <= BOUNDS.north,
    ),
  );
}

function centroid(geometry) {
  // Area-weighted centroid of the largest polygon, in frame coordinates, for the county label.
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  for (const polygon of polygons) {
    const ring = polygon[0].map(project);
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    area /= 2;
    if (!best || Math.abs(area) > Math.abs(best.area)) {
      best = { area, x: cx / (6 * area), y: cy / (6 * area) };
    }
  }
  return [round(best.x), round(best.y)];
}

const pointCounties = new Map(
  points.map((point) => [
    point.name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    point.name,
  ]),
);

const counties = feature(topology, topology.objects.counties)
  .features.filter((county) => String(county.id).startsWith("13") && inFrame(county.geometry))
  .map((county) => ({
    fips: String(county.id),
    name: county.properties.name,
    point: pointCounties.get(county.properties.name) ?? null,
    label: centroid(county.geometry),
    path: geometryPath(county.geometry),
  }))
  .sort((a, b) => a.fips.localeCompare(b.fips));

const missing = [...pointCounties.keys()].filter((name) => !counties.some((county) => county.name === name));
if (missing.length) throw new Error(`No county shape for ${missing.join(", ")}`);

const out = join(web, "public/data/map/south-georgia.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({
    schema_version: 1,
    source: "us-atlas counties-10m (US Census cartographic boundaries 1:10,000,000)",
    bounds: BOUNDS,
    width: WIDTH,
    height: HEIGHT,
    counties,
  })}\n`,
);
console.log(`${counties.length} counties, ${HEIGHT} px tall, ${out}`);
