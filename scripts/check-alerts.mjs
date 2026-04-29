#!/usr/bin/env node
// Compare the latest snapshot to historical data and emit Telegram alerts.
//
// Alert rule (from Jon):
//   Fire when ANY retailer:
//     (a) drops 10%+ below their own historical best, OR
//     (b) drops below LUBA.com.au current price (importer floor)
//
// Bundles: subtract included accessories at retail value before comparing
// (TODO: bundleContents.accessoryValue once we wire that up).
//
// Usage:
//   node scripts/check-alerts.mjs            # compare + post if triggered
//   node scripts/check-alerts.mjs --dry      # compare + print only
//   node scripts/check-alerts.mjs --force    # post the latest state regardless
//
// Env required for actual posting (when not --dry):
//   TG_BOT_TOKEN   — pulls from ~/.openclaw/.env if not set
//   TG_CHAT_ID     — defaults to Jon DM (8630944179) but can override

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SNAPSHOT_DIR = path.join(PROJECT_ROOT, 'data', 'snapshots');
const LATEST_PATH = path.join(PROJECT_ROOT, 'data', 'latest.json');
const STATE_PATH = path.join(PROJECT_ROOT, 'data', 'alerts-state.json');
const ALERT_PCT_THRESHOLD = 10; // 10% below historical best

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry');
const FORCE = args.has('--force');

function loadHistory() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return [];
  const files = fs.readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    try {
      return { file: f, ...JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, f), 'utf8')) };
    } catch (e) {
      return { file: f, error: e.message };
    }
  }).filter((s) => !s.error);
}

function fmtAud(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 0 });
}

function computeHistoricalBest(history, retailerKey) {
  let best = Infinity;
  let bestDate = null;
  for (const snap of history) {
    for (const r of snap.results || []) {
      const key = r.id || `${r.name}:${r.variantTitle || ''}`;
      if (key !== retailerKey) continue;
      if (r.error || r.price == null) continue;
      if (r.available === false && r.inventoryPolicy !== 'continue') continue;
      if (r.price < best) {
        best = r.price;
        bestDate = snap.fetchedAt;
      }
    }
  }
  return best === Infinity ? null : { price: best, date: bestDate };
}

function evaluateAlerts(latest, history) {
  const triggered = [];
  const floorRetailer = (latest.results || []).find((r) => r.isFloorReference && !r.error);
  // Only trust the floor for alerts when it's both LIVE (not wayback fallback)
  // and IN STOCK. Stale or OOS floor is informational only.
  const floorAuthoritative = floorRetailer && floorRetailer.source !== 'wayback-fallback' && floorRetailer.available !== false;
  const floor = floorAuthoritative ? floorRetailer.price : null;
  const floorInformational = floorRetailer?.price ?? null;

  for (const r of latest.results || []) {
    if (r.error || r.price == null) continue;
    if (r.isFloorReference) continue; // floor is the reference, not a candidate
    if (r.available === false && r.inventoryPolicy !== 'continue') continue;
    if (r.retailerType === 'amazon' || r.retailerType === 'ebay') continue; // marketplaces noisy, defer

    const key = r.id;

    // Rule (b): below LUBA.com.au floor (only when authoritative)
    if (floor != null && r.price < floor) {
      const saving = floor - r.price;
      const pct = (saving / floor) * 100;
      triggered.push({
        type: 'below-floor',
        retailer: r.name,
        url: r.productUrl,
        currentPrice: r.price,
        floor,
        saving,
        pct,
        message: `Below LUBA.com.au floor by ${fmtAud(saving)} (${pct.toFixed(1)}%)`,
      });
    }

    // Rule (a): 10%+ below historical best (only if we have a real history with at least 2 prior snapshots)
    if (history.length >= 2) {
      const best = computeHistoricalBest(history, key);
      if (best && best.price > r.price) {
        const drop = best.price - r.price;
        const pct = (drop / best.price) * 100;
        if (pct >= ALERT_PCT_THRESHOLD) {
          triggered.push({
            type: 'below-best',
            retailer: r.name,
            url: r.productUrl,
            currentPrice: r.price,
            previousBest: best.price,
            previousBestDate: best.date,
            drop,
            pct,
            message: `${pct.toFixed(1)}% below previous best of ${fmtAud(best.price)} (${new Date(best.date).toLocaleDateString('en-AU')})`,
          });
        }
      }
    }
  }
  return { triggered, floor, floorInformational, floorAuthoritative: !!floorAuthoritative };
}

function loadAlertState() {
  if (!fs.existsSync(STATE_PATH)) return { lastSent: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { lastSent: {} }; }
}

function saveAlertState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function loadCreds() {
  if (process.env.TG_BOT_TOKEN) {
    return { token: process.env.TG_BOT_TOKEN, chatId: process.env.TG_CHAT_ID || '8630944179' };
  }
  // try ~/.openclaw/.env
  const home = process.env.USERPROFILE || process.env.HOME;
  const env = readEnvFile(path.join(home, '.openclaw', '.env'));
  return {
    token: env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN,
    chatId: process.env.TG_CHAT_ID || '8630944179',
  };
}

async function postTelegram(text) {
  const { token, chatId } = loadCreds();
  if (!token) {
    console.error('No Telegram bot token available — set TG_BOT_TOKEN or TELEGRAM_BOT_TOKEN in ~/.openclaw/.env');
    return false;
  }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  const data = await r.json();
  if (!data.ok) {
    console.error('Telegram send failed:', data);
    return false;
  }
  return true;
}

function formatAlertMessage(triggered, floor, latest) {
  const lines = ['🌱 <b>LUBA 2 AWD 3000X — price alert</b>'];
  if (floor != null) lines.push(`Importer floor (LUBA.com.au): <b>${fmtAud(floor)}</b>`);
  lines.push('');
  for (const t of triggered) {
    lines.push(`• <b>${t.retailer}</b>: <b>${fmtAud(t.currentPrice)}</b>`);
    lines.push(`  ${t.message}`);
    lines.push(`  <a href="${t.url}">${t.url}</a>`);
    lines.push('');
  }
  lines.push(`<i>${new Date(latest.fetchedAt).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}</i>`);
  return lines.join('\n');
}

// MAIN -----------------------------------------------------------------------

if (!fs.existsSync(LATEST_PATH)) {
  console.error('No latest.json — run snapshot first.');
  process.exit(1);
}
const latest = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
const history = loadHistory();

console.log(`Snapshot at ${latest.fetchedAt} — ${history.length} historical snapshots`);

const { triggered, floor, floorInformational, floorAuthoritative } = evaluateAlerts(latest, history);

if (!triggered.length && !FORCE) {
  const floorMsg = floorAuthoritative ? `floor=${fmtAud(floor)}` : `floor=stale/OOS (${fmtAud(floorInformational)})`;
  console.log(`No alerts. (${floorMsg}, latest cheapest=${fmtAud(latest.summary?.cheapestMower?.price)})`);
  process.exit(0);
}

const message = triggered.length
  ? formatAlertMessage(triggered, floor, latest)
  : `🌱 LUBA 2 AWD 3000X — manual snapshot\nCheapest: ${fmtAud(latest.summary?.cheapestMower?.price)}\nFloor: ${fmtAud(floor)}\n${latest.fetchedAt}`;

console.log('---');
console.log(message);
console.log('---');

if (DRY) {
  console.log('[--dry] not posting.');
  process.exit(0);
}

// Dedup: don't repost the same alert for the same retailer within 24h unless price drops further
const state = loadAlertState();
const sendable = triggered.filter((t) => {
  const last = state.lastSent[t.retailer];
  if (!last) return true;
  const ageMs = Date.now() - new Date(last.at).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) return true; // re-alert after 24h
  return t.currentPrice < last.price; // only resend if price dropped further
});

if (!sendable.length && !FORCE) {
  console.log('All alerts already sent in last 24h with no further drop. Skipping.');
  process.exit(0);
}

const ok = await postTelegram(message);
if (ok) {
  for (const t of triggered) {
    state.lastSent[t.retailer] = { at: new Date().toISOString(), price: t.currentPrice };
  }
  saveAlertState(state);
  console.log('Posted to Telegram.');
}
