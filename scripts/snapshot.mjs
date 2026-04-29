#!/usr/bin/env node
// LUBA 2 AWD 3000X price snapshot — config-driven.
// Usage:  node scripts/snapshot.mjs           → writes data/snapshots/<UTC>.json + updates latest.json
//         node scripts/snapshot.mjs --print   → also prints a human summary
//         node scripts/snapshot.mjs --dry     → don't persist, just print
//
// Adds: Shopify retailers via /products.json + /products/<handle>.js,
//       Mammotion DM AU + LUBA.com.au scrapers (HTML / WooCommerce),
//       Amazon AU + eBay AU search snapshots.
//
// Each retailer entry result shape:
//   {
//     id, name, retailerType ('shopify'|'woo'|'html'|'amazon'|'ebay'|'marketplace'),
//     url, productUrl, title, variantTitle, sku,
//     price (number AUD), compareAt (number|null), currency: 'AUD',
//     available (true|false|null), inventoryNote (string|null),
//     isBundle (bool), bundleContents (string|null),
//     fetchedAt (ISO),
//     error (string|null)
//   }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'data', 'snapshots');
const LATEST_PATH = path.join(PROJECT_ROOT, 'data', 'latest.json');

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const PRINT = args.has('--print') || DRY;

const config = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'retailers.json'), 'utf8'));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...opts,
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-AU,en;q=0.9', ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Shopify ---------------------------------------------------------

async function checkShopifyVariantStock(storeUrl, handle, variantId) {
  try {
    const r = await fetchWithTimeout(`${storeUrl}/products/${handle}.js`);
    if (!r.ok) return null;
    const data = await r.json();
    const v = (data.variants || []).find((x) => String(x.id) === String(variantId));
    if (!v) return null;
    return {
      available: !!v.available,
      inventoryQuantity: v.inventory_quantity ?? null,
      inventoryPolicy: v.inventory_policy ?? null,
    };
  } catch {
    return null;
  }
}

function pickPreferredVariant(product) {
  const variants = product.variants || [];
  const want = variants.find(
    (v) => /3000/.test(v.title || '') || /3000/.test(v.option1 || '') || /3000/.test(v.option2 || ''),
  );
  return want || variants[0] || null;
}

async function snapshotShopifyProduct(retailer, handle) {
  const productUrl = `${retailer.url}/products/${handle}`;
  const result = {
    id: `${retailer.id}:${handle}`,
    name: retailer.name + (retailer.productHandles?.length > 1 ? ` (${handle})` : ''),
    retailerType: 'shopify',
    url: retailer.url,
    productUrl,
    isBundle: !!handle.match(/garage|bundle|kit|combo|ultimate/i),
    bundleContents: null,
    isOfficial: !!retailer.isOfficial,
    isAuthorisedDealer: !!retailer.isAuthorisedDealer,
    currency: 'AUD',
    fetchedAt: new Date().toISOString(),
  };
  try {
    const r = await fetchWithTimeout(`${productUrl}.json`);
    if (!r.ok) {
      result.error = `HTTP ${r.status}`;
      return result;
    }
    const data = await r.json();
    const product = data.product;
    if (!product) {
      result.error = 'no product in response';
      return result;
    }
    const variant = pickPreferredVariant(product);
    if (!variant) {
      result.error = 'no variants';
      return result;
    }
    const liveStock = await checkShopifyVariantStock(retailer.url, handle, variant.id);
    result.title = product.title;
    result.variantTitle = variant.title;
    result.variantId = variant.id;
    result.sku = variant.sku || null;
    result.price = parseFloat(variant.price);
    result.compareAt = variant.compare_at_price ? parseFloat(variant.compare_at_price) : null;
    result.available = liveStock?.available ?? null;
    result.inventoryQuantity = liveStock?.inventoryQuantity ?? null;
    result.inventoryPolicy = liveStock?.inventoryPolicy ?? null;
    result.allVariants = (product.variants || []).map((v) => ({
      id: v.id,
      title: v.title,
      price: parseFloat(v.price),
      sku: v.sku,
    }));
  } catch (e) {
    result.error = `fetch failed: ${e.message}`;
  }
  return result;
}

// ---------- WooCommerce (LUBA.com.au) --------------------------------------
//
// LUBA.com.au is a WooCommerce store. The product variations are exposed via
//   POST /?wc-ajax=get_variation
// or as an inline data-product_variations JSON blob on the product page.
// We try the inline blob first (no JS execution required).

async function snapshotWooProduct(retailer, productPath) {
  const productUrl = `${retailer.url}${productPath}`;
  const result = {
    id: `${retailer.id}:${productPath}`,
    name: retailer.name,
    retailerType: 'woo',
    url: retailer.url,
    productUrl,
    isBundle: false,
    isOfficial: !!retailer.isOfficial,
    isFloorReference: !!retailer.isFloorReference,
    currency: 'AUD',
    fetchedAt: new Date().toISOString(),
  };
  try {
    const r = await fetchWithTimeout(productUrl, { timeoutMs: 20000 });
    if (!r.ok) {
      result.error = `HTTP ${r.status}`;
      return result;
    }
    const html = await r.text();
    // Strategy 1: data-product_variations attribute
    const m = html.match(/data-product_variations\s*=\s*(?:'|&quot;|")([\s\S]+?)(?:'|&quot;|")\s+/);
    let variations = null;
    if (m) {
      try {
        const decoded = m[1].replace(/&quot;/g, '"');
        variations = JSON.parse(decoded);
      } catch {
        // fall through
      }
    }
    if (variations && Array.isArray(variations)) {
      // Find the 3000 variant
      const v = variations.find((x) => {
        const attrs = Object.values(x.attributes || {}).map((s) => String(s).toLowerCase());
        return attrs.some((a) => a.includes('3000'));
      });
      if (v) {
        result.title = v.sku || 'LUBA 2 AWD 3000';
        result.variantTitle = Object.values(v.attributes || {}).join(' / ');
        result.variantId = v.variation_id;
        result.sku = v.sku || null;
        result.price = parseFloat(v.display_price);
        result.compareAt = v.display_regular_price && v.display_regular_price > v.display_price
          ? parseFloat(v.display_regular_price)
          : null;
        result.available = !!v.is_in_stock;
        result.allVariations = variations.map((x) => ({
          id: x.variation_id,
          attrs: x.attributes,
          price: parseFloat(x.display_price),
          inStock: !!x.is_in_stock,
        }));
        return result;
      }
    }
    // Strategy 2: parse JSON-LD or visible price elements as a coarse fallback
    const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g)];
    for (const lm of ldMatches) {
      try {
        const parsed = JSON.parse(lm[1].trim());
        const offers = parsed.offers || parsed['@graph']?.find?.((g) => g.offers)?.offers;
        if (offers) {
          const arr = Array.isArray(offers) ? offers : [offers];
          // pick the offer that mentions 3000
          const o = arr.find((x) => /3000/.test(JSON.stringify(x))) || arr[0];
          if (o) {
            result.title = parsed.name || 'LUBA 2 AWD';
            result.variantTitle = '3000 (from JSON-LD)';
            result.price = parseFloat(o.price || o.lowPrice);
            result.compareAt = null;
            result.available = (o.availability || '').includes('InStock');
            result.note = 'fallback JSON-LD parse — variation table not found';
            return result;
          }
        }
      } catch {
        // continue
      }
    }
    result.error = 'could not extract variations from WooCommerce page';
  } catch (e) {
    result.error = `fetch failed: ${e.message}`;
  }
  return result;
}

// ---------- Generic HTML scraper (Mammotion DM custom site) ----------------

async function snapshotHtmlProduct(retailer, productPath, opts = {}) {
  const productUrl = `${retailer.url}${productPath}`;
  const result = {
    id: `${retailer.id}:${productPath}`,
    name: retailer.name,
    retailerType: 'html',
    url: retailer.url,
    productUrl,
    isBundle: false,
    currency: 'AUD',
    fetchedAt: new Date().toISOString(),
  };
  try {
    const r = await fetchWithTimeout(productUrl, { timeoutMs: 20000 });
    if (!r.ok) {
      result.error = `HTTP ${r.status}`;
      return result;
    }
    const html = await r.text();
    // Try JSON-LD first — most modern stores include Product schema
    const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g)];
    for (const lm of ldMatches) {
      try {
        const parsed = JSON.parse(lm[1].trim());
        const candidates = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
        for (const node of candidates) {
          if ((node['@type'] === 'Product' || node['@type']?.includes?.('Product')) && node.offers) {
            const offers = Array.isArray(node.offers) ? node.offers : [node.offers];
            const o = offers.find((x) => /3000/.test(JSON.stringify(x))) || offers[0];
            if (o) {
              result.title = node.name || 'LUBA 2 AWD';
              result.variantTitle = opts.variantHint || '3000';
              result.price = parseFloat(o.price || o.lowPrice);
              result.compareAt = null;
              result.available = (o.availability || '').toLowerCase().includes('instock');
              return result;
            }
          }
        }
      } catch {
        // continue
      }
    }
    result.error = 'could not find Product schema in HTML';
  } catch (e) {
    result.error = `fetch failed: ${e.message}`;
  }
  return result;
}

// ---------- Marketplace merge ----------------------------------------------
//
// Marketplaces (eBay AU, Amazon AU) require a headless browser to bypass
// Akamai/anti-bot. They're scraped by `browser-marketplace.mjs` which writes
// `data/marketplace-snapshot.json`. We merge those results into the main
// snapshot here. Mammotion DM AU and LUBA.com.au are confirmed unfixable from
// any client (TLS/DNS broken at the retailer's end — see browser-marketplace.mjs).

function loadMarketplaceSnapshot() {
  const p = path.join(PROJECT_ROOT, 'data', 'marketplace-snapshot.json');
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  }
}

// ---------- Driver ----------------------------------------------------------

async function runSnapshot() {
  const tasks = [];

  for (const r of config.retailers || []) {
    if (r.shopify && r.productHandles?.length) {
      for (const handle of r.productHandles) {
        tasks.push(() => snapshotShopifyProduct(r, handle));
      }
    } else if (r.id === 'luba-com-au') {
      tasks.push(() => snapshotWooProduct(r, '/product/product-luba2-awd/'));
    } else if (r.id === 'mammotion-dm') {
      tasks.push(() => snapshotHtmlProduct(r, '/products/luba-2-awd-3000x', { variantHint: '3000X' }));
    }
  }

  const results = [];
  for (const t of tasks) {
    try {
      results.push(await t());
    } catch (e) {
      results.push({ error: `task crashed: ${e.message}` });
    }
  }

  // Merge in the latest marketplace snapshot (browser-driven, separate run)
  const mp = loadMarketplaceSnapshot();
  results.push(...mp);
  return results;
}

function summarise(results) {
  const ok = results.filter((r) => !r.error && r.price);
  const failed = results.filter((r) => r.error);
  const mowers = ok.filter((r) => !r.isBundle && r.retailerType !== 'amazon' && r.retailerType !== 'ebay');
  const bundles = ok.filter((r) => r.isBundle);
  const marketplaces = ok.filter((r) => r.retailerType === 'amazon' || r.retailerType === 'ebay');
  const floor = ok.find((r) => r.isFloorReference)?.price ?? null;

  let cheapestMower = null;
  if (mowers.length) {
    const sorted = [...mowers].sort((a, b) => a.price - b.price);
    cheapestMower = { name: sorted[0].name, price: sorted[0].price, url: sorted[0].productUrl };
  }
  return { ok: ok.length, failed: failed.length, cheapestMower, floor, mowerCount: mowers.length, bundleCount: bundles.length, marketplaceCount: marketplaces.length };
}

function printHuman(results, summary) {
  console.log('=== LUBA 2 AWD 3000X — snapshot ===\n');
  for (const r of results) {
    if (r.error) {
      console.log(`  ✗ ${r.name || r.id || '(unknown)'}: ${r.error}`);
      continue;
    }
    let stockTag = ' ? STOCK UNKNOWN';
    if (r.available === true) stockTag = ' ✓ IN STOCK';
    else if (r.available === false) stockTag = (r.inventoryPolicy === 'continue') ? ' ✓ BACKORDER OK' : ' ✗ OUT OF STOCK';
    const sale = r.compareAt && r.compareAt > r.price ? ` [WAS $${r.compareAt}]` : '';
    const tag = r.isBundle ? ' [BUNDLE]' : (r.isFloorReference ? ' [FLOOR]' : (r.isOfficial ? ' [OFFICIAL]' : ''));
    console.log(`  ${r.name}${tag}${stockTag}`);
    console.log(`     Variant: ${r.variantTitle || '-'}`);
    console.log(`     Price: $${r.price?.toLocaleString('en-AU')}${sale}`);
    if (r.priceMin && r.priceMax) console.log(`     Listings range: $${r.priceMin} – $${r.priceMax} (n=${r.listings})`);
    console.log(`     ${r.productUrl}`);
    console.log('');
  }
  console.log('---');
  if (summary.cheapestMower) {
    console.log(`💰 Cheapest mower: $${summary.cheapestMower.price.toLocaleString('en-AU')} — ${summary.cheapestMower.name}`);
  }
  if (summary.floor) console.log(`🧱 LUBA.com.au floor: $${summary.floor.toLocaleString('en-AU')}`);
  console.log(`✓ ${summary.ok} ok / ✗ ${summary.failed} failed`);
}

function persist(results, summary) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SNAPSHOT_DIR, `${ts}.json`);
  const payload = { fetchedAt: new Date().toISOString(), summary, results };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  fs.writeFileSync(LATEST_PATH, JSON.stringify(payload, null, 2));
  return file;
}

// MAIN
const results = await runSnapshot();
const summary = summarise(results);
if (PRINT) printHuman(results, summary);
if (!DRY) {
  const file = persist(results, summary);
  console.log(`\nWrote: ${path.relative(PROJECT_ROOT, file)}`);
  console.log(`Wrote: ${path.relative(PROJECT_ROOT, LATEST_PATH)}`);
}
