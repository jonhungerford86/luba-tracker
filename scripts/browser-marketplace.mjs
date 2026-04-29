#!/usr/bin/env node
// Browser-driven marketplace + custom-site scraper.
// Uses Playwright (headless chromium) with a stealth init script and warm-cookie
// nav pattern to bypass anti-bot on eBay AU. Targets sites that block plain fetch:
//   - eBay AU search (Akamai EdgeSuite blocks plain fetch; cookie warm-up + .s-card selector works)
//   - Amazon AU search (anti-bot lite; data-component-type=s-search-result still works)
//   - Mammotion DM AU (CONFIRMED unfixable: TLS internal_error from CloudFront edge across all clients including Chromium)
//   - LUBA.com.au (CONFIRMED unfixable: Cloudflare authoritative DNS returning REFUSED — the importer's DNS is broken)
//
// Usage: node scripts/browser-marketplace.mjs
//   Writes data/marketplace-snapshot.json (merged into the main snapshot by snapshot.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(PROJECT_ROOT, 'data', 'marketplace-snapshot.json');

// Filter helpers: exclude accessories so the marketplace "headline price" is
// actually the mower, not a $35 set of blades.
const ACCESSORY_PATTERNS = [
  /blade/i, /cable/i, /charger/i, /charging/i, /tire/i, /tyre/i, /tube/i, /tubing/i,
  /accessor/i, /case/i, /cover/i, /bumper/i, /apron/i, /protect/i, /mount/i, /antenna/i,
  /disc/i, /disk/i, /screw/i, /battery only/i, /knife/i, /helmet/i, /sticker/i,
  /replacement/i, /spare part/i, /spare blade/i,
];
const isAccessory = (title) => ACCESSORY_PATTERNS.some((re) => re.test(title));

const TARGETS = [
  {
    id: 'ebay-au',
    name: 'eBay AU',
    type: 'ebay',
    url: 'https://www.ebay.com.au/sch/i.html?_nkw=Mammotion+LUBA+2+AWD+3000X&_sop=15',
    needsWarmup: true,
    extract: async (page) => {
      // Wait for results to load
      await page.waitForSelector('.s-card', { timeout: 12000 }).catch(() => null);
      await page.waitForTimeout(1500);
      const items = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.s-card').forEach((card) => {
          const titleEl = card.querySelector('.s-card__title, [data-testid="item-title"], .s-card__main-title, h3');
          const priceEl = card.querySelector('.s-card__price, [data-testid="item-price"], .s-item__price');
          const link = card.querySelector('a')?.href || '';
          if (!titleEl || !priceEl) return;
          let title = titleEl.innerText.trim().replace(/\nOpens in a new window or tab$/, '');
          const priceText = priceEl.innerText.trim();
          // Match AU $1,234.00 or just $1,234
          const m = priceText.match(/(?:AU\s*)?\$\s*([\d,]+(?:\.\d{2})?)/);
          if (!m) return;
          const price = parseFloat(m[1].replace(/,/g, ''));
          out.push({ title, price, priceText, url: link.split('?')[0] });
        });
        return out;
      });
      // Filter: price >= $1500 (mower, not accessory) AND title contains "luba" AND NOT in accessory list
      return items.filter(
        (it) => it.price >= 1500 && /luba/i.test(it.title) && /3000/.test(it.title) && !ACCESSORY_PATTERNS.some((re) => re.test(it.title)),
      );
    },
  },
  {
    id: 'amazon-au',
    name: 'Amazon AU',
    type: 'amazon',
    url: 'https://www.amazon.com.au/s?k=Mammotion+LUBA+2+AWD+3000X',
    extract: async (page) => {
      await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 15000 }).catch(() => null);
      const items = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('[data-component-type="s-search-result"]').forEach((card) => {
          // Amazon AU varies the title between .a-size-medium (sometimes just brand)
          // and .a-size-base-plus, with the full product title spread across multiple spans.
          // Best signal: the longest text span >30 chars containing 'luba'.
          const allSpans = [...card.querySelectorAll('span')].map((s) => s.innerText.trim()).filter(Boolean);
          const longTitle = allSpans.find((s) => s.length > 30 && /luba/i.test(s)) || allSpans.find((s) => s.length > 20);
          const titleMedium = card.querySelector('.a-size-medium, .a-size-base-plus')?.innerText.trim();
          const title = longTitle || titleMedium || '';
          const priceEl = card.querySelector('.a-price .a-offscreen');
          const linkEl = card.querySelector('a.a-link-normal[role="link"]') || card.querySelector('h2 a');
          const asin = card.getAttribute('data-asin');
          if (!title || !priceEl) return;
          const priceText = priceEl.innerText.trim();
          const m = priceText.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
          if (!m) return;
          const price = parseFloat(m[1].replace(/,/g, ''));
          out.push({ asin, title: title.replace(/^Sponsored\s*\n?/i, '').trim(), price, priceText, url: linkEl?.href || '' });
        });
        return out;
      });
      // Dedupe by ASIN (Amazon repeats the same listing as sponsored + organic)
      const seen = new Set();
      const unique = items.filter((it) => {
        if (!it.asin || seen.has(it.asin)) return false;
        seen.add(it.asin);
        return true;
      });
      return unique.filter(
        (it) => it.price >= 1500 && /luba.*3000x/i.test(it.title) && !ACCESSORY_PATTERNS.some((re) => re.test(it.title)),
      );
    },
  },
  // Mammotion DM AU and LUBA.com.au are intentionally not in TARGETS — they're
  // unfixable from any client. See top-of-file comment.
];

async function snapshotTarget(ctx, target) {
  const result = {
    id: target.id,
    name: target.name,
    retailerType: target.type,
    productUrl: target.url,
    url: new URL(target.url).origin,
    currency: 'AUD',
    fetchedAt: new Date().toISOString(),
  };
  const page = await ctx.newPage();
  try {
    if (target.needsWarmup) {
      // Visit homepage first to seed cookies
      await page.goto(new URL(target.url).origin, { timeout: 20000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
    }
    await page.goto(target.url, { timeout: 25000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const items = await target.extract(page);

    if (items.length) {
      items.sort((a, b) => a.price - b.price);
      result.title = `Mammotion LUBA 2 AWD 3000X (${target.name} search)`;
      result.variantTitle = `${items.length} mower listing${items.length === 1 ? '' : 's'}`;
      result.price = items[0].price;
      result.priceMin = items[0].price;
      result.priceMax = items[items.length - 1].price;
      result.priceMedian = items[Math.floor(items.length / 2)].price;
      result.listings = items.length;
      result.available = true;
      result.topListings = items.slice(0, 5).map((i) => ({ title: i.title.slice(0, 100), price: i.price, url: i.url, asin: i.asin }));
    } else {
      result.error = 'no qualifying mower listings (after accessory filter)';
    }
  } catch (e) {
    result.error = `nav/extract failed: ${e.message.split('\n')[0]}`;
  } finally {
    await page.close().catch(() => null);
  }
  return result;
}

async function run() {
  console.log('Launching chromium (headless)...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'en-AU',
    timezoneId: 'Australia/Brisbane',
  });
  // Stealth: hide automation flags eBay/Akamai sniffs for
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  });

  const results = [];
  for (const target of TARGETS) {
    console.log(`-> ${target.id}`);
    const r = await snapshotTarget(ctx, target);
    console.log(`   ${r.error ? `[ERR] ${r.error}` : `[ok] $${r.price} (${r.listings} listings, range $${r.priceMin}-$${r.priceMax})`}`);
    results.push(r);
  }

  await browser.close();

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nWrote ${path.relative(PROJECT_ROOT, OUT_PATH)}`);
}

await run();
