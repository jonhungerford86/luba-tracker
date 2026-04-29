#!/usr/bin/env node
// Seed historical price points from the Wayback Machine for each retailer.
//
// Strategy:
//   For each Shopify product URL, query Wayback CDX API for snapshots over the
//   last N months, then for each unique snapshot fetch the captured page,
//   extract the price. Build a synthetic snapshot file per timestamp written
//   into data/snapshots/ alongside the live snapshots.
//
// Usage:
//   node scripts/seed-wayback.mjs --months 12         # seed last 12 months
//   node scripts/seed-wayback.mjs --months 6 --dry    # print what would be seeded
//   node scripts/seed-wayback.mjs --retailer mammotion-au   # one retailer only

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'data', 'snapshots');

const args = process.argv.slice(2);
function getArg(name, dflt) {
  const i = args.indexOf(name);
  if (i < 0) return dflt;
  return args[i + 1];
}
const MONTHS = parseInt(getArg('--months', '12'), 10);
const RETAILER_FILTER = getArg('--retailer', null);
const DRY = args.includes('--dry');

const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'retailers.json'), 'utf8'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0';

function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }

async function cdxList(target, fromYmd, toYmd) {
  // CDX API. Limit to ~30 captures, dedup by digest, only 200 OK.
  const params = new URLSearchParams({
    url: target,
    from: fromYmd,
    to: toYmd,
    output: 'json',
    fl: 'timestamp,original,statuscode,digest',
    filter: 'statuscode:200',
    collapse: 'digest',
    limit: '40',
  });
  const r = await fetch(`https://web.archive.org/cdx/search/cdx?${params}`, { headers: { 'User-Agent': UA } });
  if (!r.ok) return [];
  const data = await r.json();
  if (!Array.isArray(data) || data.length < 2) return [];
  return data.slice(1); // first row is header
}

async function fetchWaybackPage(timestamp, original) {
  const url = `https://web.archive.org/web/${timestamp}id_/${original}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  return r.text();
}

function extractPriceFromShopifyJson(html) {
  // Wayback often captures both .json and .html versions. If we hit the JSON
  // (when target was products/<handle>.json), parse directly.
  try {
    const data = JSON.parse(html);
    if (data && data.product) {
      const variants = data.product.variants || [];
      const want = variants.find((v) => /3000/.test(v.title || '') || /3000/.test(v.option1 || ''))
                || variants[0];
      if (want) return { price: parseFloat(want.price), variantTitle: want.title };
    }
  } catch {
    // not JSON; fall through
  }
  return null;
}

function extractPriceFromHtml(html) {
  // Try JSON-LD Product schema
  const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g)];
  for (const lm of ldMatches) {
    try {
      const parsed = JSON.parse(lm[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      for (const node of candidates) {
        if ((node['@type'] === 'Product' || (Array.isArray(node['@type']) && node['@type'].includes('Product'))) && node.offers) {
          const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
          // pick the one mentioning 3000 if multiple
          const o = offers.find((x) => /3000/.test(JSON.stringify(x))) || offers[0];
          if (o && (o.price || o.lowPrice)) {
            return { price: parseFloat(o.price || o.lowPrice), variantTitle: '(JSON-LD)' };
          }
        }
      }
    } catch {
      // continue
    }
  }
  // Generic price meta tag fallback
  const m = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d.]+)["']/);
  if (m) return { price: parseFloat(m[1]), variantTitle: '(meta tag)' };
  return null;
}

async function seedRetailer(retailer, handle) {
  if (!retailer.shopify) {
    console.log(`  [skip] ${retailer.id} not Shopify-based, skipping wayback seed`);
    return [];
  }
  const target = `${retailer.url}/products/${handle}`;
  console.log(`\n=> ${retailer.id}: ${target}`);
  const now = new Date();
  const from = new Date(now.getTime() - MONTHS * 30 * 86400 * 1000);
  const captures = await cdxList(target, ymd(from), ymd(now));
  console.log(`   ${captures.length} unique captures in last ${MONTHS} months`);
  if (!captures.length) return [];

  const seeded = [];
  for (const [timestamp, original] of captures) {
    const wbDate = new Date(`${timestamp.slice(0,4)}-${timestamp.slice(4,6)}-${timestamp.slice(6,8)}T${timestamp.slice(8,10)}:${timestamp.slice(10,12)}:${timestamp.slice(12,14)}Z`);
    // Try the .json variant first (cheaper) — append .json to the URL
    const tryJson = original.endsWith('.json') ? original : original + '.json';
    let extracted = null;
    let body = await fetchWaybackPage(timestamp, tryJson).catch(() => null);
    if (body) extracted = extractPriceFromShopifyJson(body);
    if (!extracted) {
      body = await fetchWaybackPage(timestamp, original).catch(() => null);
      if (body) extracted = extractPriceFromHtml(body);
    }
    if (!extracted || !extracted.price) {
      console.log(`   [no-price] ${timestamp}`);
      continue;
    }
    seeded.push({
      timestamp,
      fetchedAt: wbDate.toISOString(),
      retailer,
      handle,
      target,
      result: {
        id: `${retailer.id}:${handle}`,
        name: retailer.name + (retailer.productHandles?.length > 1 ? ` (${handle})` : ''),
        retailerType: 'shopify',
        url: retailer.url,
        productUrl: target,
        title: extracted.variantTitle,
        variantTitle: extracted.variantTitle,
        price: extracted.price,
        compareAt: null,
        currency: 'AUD',
        available: null, // unknown from historical capture
        isOfficial: !!retailer.isOfficial,
        isAuthorisedDealer: !!retailer.isAuthorisedDealer,
        isBundle: !!handle.match(/garage|bundle|kit|combo|ultimate/i),
        fetchedAt: wbDate.toISOString(),
        source: 'wayback',
      },
    });
    console.log(`   [ok] ${wbDate.toISOString().slice(0,10)} -> $${extracted.price}`);
    // be polite to wayback
    await new Promise((r) => setTimeout(r, 250));
  }
  return seeded;
}

async function main() {
  // Build target list: each (retailer, handle) pair
  const tasks = [];
  for (const r of config.retailers) {
    if (RETAILER_FILTER && r.id !== RETAILER_FILTER) continue;
    if (!r.shopify) continue;
    for (const h of r.productHandles || []) tasks.push({ retailer: r, handle: h });
  }
  if (!tasks.length) {
    console.log('No Shopify retailer handles to seed.');
    return;
  }

  const allSeeded = [];
  for (const t of tasks) {
    const seeded = await seedRetailer(t.retailer, t.handle);
    allSeeded.push(...seeded);
  }
  console.log(`\nTotal historical price points: ${allSeeded.length}`);
  if (DRY) {
    console.log('[--dry] not writing snapshots.');
    return;
  }

  // Group by timestamp; one synthetic snapshot per unique (date, retailer)
  // We don't try to combine retailers into one snapshot file because the wayback
  // captures don't line up across retailers. Instead: write one file per
  // retailer-capture, all marked source=wayback so they're easy to filter.
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  let written = 0;
  for (const s of allSeeded) {
    const ts = s.fetchedAt.replace(/[:.]/g, '-');
    const file = path.join(SNAPSHOT_DIR, `${ts}-wb-${s.retailer.id}.json`);
    if (fs.existsSync(file)) continue;
    const payload = {
      fetchedAt: s.fetchedAt,
      source: 'wayback',
      summary: { ok: 1, failed: 0, cheapestMower: null, floor: null, mowerCount: s.result.isBundle ? 0 : 1, bundleCount: s.result.isBundle ? 1 : 0, marketplaceCount: 0 },
      results: [s.result],
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    written++;
  }
  console.log(`Wrote ${written} new snapshot files to data/snapshots/.`);
}

await main();
