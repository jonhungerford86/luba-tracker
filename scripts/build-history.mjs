#!/usr/bin/env node
// Build data/history.json — a per-retailer time series the dashboard can read.
//
// Output shape:
//   {
//     builtAt: ISO,
//     series: {
//       "<retailerId>": [
//         { date: "YYYY-MM-DD", price: 4199, source: "live"|"wayback", available: bool|null }
//       ]
//     }
//   }
//
// Reads everything in data/snapshots/. Picks one entry per (retailer, day) — the
// last one wins on conflicts so live samples beat wayback at same date.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'data', 'snapshots');
const OUT_PATH = path.join(PROJECT_ROOT, 'data', 'history.json');

const files = fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json')).sort();
const series = {};

for (const f of files) {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, f), 'utf8')); }
  catch { continue; }
  if (!snap.results || !Array.isArray(snap.results)) continue;
  const isWayback = snap.source === 'wayback' || f.includes('-wb-');
  for (const r of snap.results) {
    if (r.error || r.price == null) continue;
    if (!r.id) continue;
    const date = (r.fetchedAt || snap.fetchedAt || '').slice(0, 10);
    if (!date) continue;
    if (!series[r.id]) series[r.id] = [];
    series[r.id].push({
      date,
      price: r.price,
      compareAt: r.compareAt ?? null,
      available: r.available ?? null,
      source: isWayback ? 'wayback' : 'live',
      name: r.name,
      productUrl: r.productUrl,
    });
  }
}

// Dedup per (retailer, date): keep last one (sorted by file = chronological)
for (const id of Object.keys(series)) {
  const seenDate = new Map();
  for (const point of series[id]) {
    seenDate.set(point.date, point);
  }
  series[id] = [...seenDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const out = { builtAt: new Date().toISOString(), retailerCount: Object.keys(series).length, series };
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`Built ${path.relative(PROJECT_ROOT, OUT_PATH)} — ${out.retailerCount} retailers, ${Object.values(series).reduce((s, a) => s + a.length, 0)} points total`);
for (const [id, points] of Object.entries(series)) {
  const prices = points.map((p) => p.price);
  console.log(`  ${id}: ${points.length} points, range $${Math.min(...prices)}–$${Math.max(...prices)}`);
}
