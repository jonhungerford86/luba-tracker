# LUBA 2 AWD 3000X — Australian Price Tracker

Daily snapshots of the Mammotion LUBA 2 AWD 3000X across all known Australian retailers and marketplaces. Live dashboard:

**https://jonhungerford86.github.io/luba-tracker/**

## What it does

- Snapshots prices and stock status from every AU retailer that sells the LUBA 2 AWD 3000X variant
- Uses LUBA.com.au (the exclusive AU importer) as the price floor reference
- Tracks bundles separately so we can subtract included accessories at retail value
- Static GitHub Pages dashboard — no backend, just JSON in the repo
- Telegram alerts (private) when any retailer drops 10%+ below their historical best, OR below the LUBA.com.au floor

## Layout

```
luba-tracker/
├── index.html           ← GitHub Pages dashboard (served from repo root)
├── data/
│   ├── latest.json      ← what the dashboard reads
│   └── snapshots/       ← one file per run, timestamped
├── scripts/
│   └── snapshot.mjs     ← run once → writes data/{latest.json, snapshots/<ts>.json}
├── retailers.json       ← retailer + alert config
└── README.md
```

## Running a snapshot

```bash
node scripts/snapshot.mjs            # writes data, no console output
node scripts/snapshot.mjs --print    # writes + prints human summary
node scripts/snapshot.mjs --dry      # prints only, no persist
```

## Daily cron (planned)

Runs on the integration VM at 06:00 AEST:
1. `node scripts/snapshot.mjs`
2. `git add data && git commit -m "snapshot $(date)"`
3. `git push` → GitHub Pages rebuilds automatically
4. Diff against previous snapshot → if alert rule triggers → POST to Telegram

## Retailer status

| Retailer | Type | Status |
|---|---|---|
| Mammotion AU (au.mammotion.com) | Shopify | ✅ Working |
| Robot Mowers Australia | Shopify | ✅ Working (mower + bundle) |
| Ople Appliance | Shopify | ✅ Working ($4,399, currently $200 off) |
| LUBA.com.au (importer, **price floor**) | WooCommerce | ✅ Wayback fallback (live site DNS broken at importer; latest capture 2026-01-18 — floor $3,569 OOS) |
| Amazon AU | Marketplace | ✅ Working via Playwright (headless Chromium, accessory filter) |
| eBay AU | Marketplace | ✅ Working via Playwright (warm cookie + .s-card selector + accessory filter) |
| Mammotion DM AU | Custom | ⛔ Unfixable from any client — their CloudFront edge returns TLS internal_error |
| Robotic Mowing | Shopify | 🚧 No 3000X listing yet |

## Pickup checklist

- [x] **Daily cron** — OpenClaw cron `luba-tracker-daily` runs `scripts/daily.ps1` at 06:00 AEST
- [x] **GitHub repo + Pages** — live at https://jonhungerford86.github.io/luba-tracker/
- [x] **Telegram alerts** — `scripts/check-alerts.mjs` reads bot token from `~/.openclaw/.env`, posts on rule trip with 24h dedup. Floor-source-aware: won't fire on stale Wayback floor.
- [x] **6 retailers + floor** — Mammotion AU, Robot Mowers AU mower, Robot Mowers AU bundle, Ople, eBay AU, Amazon AU, plus LUBA.com.au floor via Wayback
- [x] **Wayback historical seed** — 17 points across 7 retailer/handle combos (Mammotion AU, Ople, LUBA.com.au)
- [x] **Browser scraper for marketplaces** — `scripts/browser-marketplace.mjs` uses headless Playwright with stealth init + warm-cookie nav for eBay; accessory filter so headline price is the mower not a $35 set of blades
- [x] **Historical price chart on dashboard** — inline SVG sparklines per retailer, wayback points coloured grey to distinguish from live samples
- [x] **Floor staleness handling** — dashboard labels floor source (live / Wayback / OOS), alert script doesn't trigger when floor is stale
- [ ] **Robotic Mowing** — add 3000X handle once they list it (currently older models only)
- [ ] **Mammotion DM AU** — confirmed unfixable from any client (TLS internal_error from their CloudFront edge). Either contact them to fix their cert config, or accept this retailer is out of scope.
- [ ] **Wayback seed for Robot Mowers AU** — currently 0 captures, may need Wayback save-page-now to seed
- [ ] **Bundle accessory subtraction** — alert rule says "subtract included accessories at retail value" before comparing bundle to mower-only; not implemented yet (Garage Kit at $4,560 = $361 over bare mower, which roughly matches the $200 garage + $80 cable + $80 mount retail values, but we should make this explicit)

## Data sources & gotchas

| Source | How it works | Failure mode |
|---|---|---|
| Shopify storefronts | `/products/<handle>.json` for catalog data + `/products/<handle>.js` for live `available` flag | None observed; reliable across all 4 Shopify retailers |
| LUBA.com.au (WooCommerce) | Live fetch first; fallback to Wayback Machine CDX + parse `data-product_variations` HTML attribute | Live currently 100% broken (importer DNS misconfigured at Cloudflare) |
| eBay AU | Headless Playwright with warm-cookie nav + `.s-card` selector + price/title accessory filter | Akamai EdgeSuite blocks plain fetch and unwarmed headless sessions |
| Amazon AU | Headless Playwright + dedupe by ASIN + accessory filter | First-page results vary between fetches; LUBA mower not always shown organically |
| Mammotion DM AU | Confirmed unfixable | CloudFront returns TLS `internal_error` to every client including Chromium |
| Wayback historical | CDX API + balanced-brace JSON extraction from `var meta = {...};` (ShopifyAnalytics format, prices in cents) or WooCommerce `data-product_variations` | Some retailers have 0 captures (Robot Mowers AU); some captures are pre-3000X variant (skipped by SKU filter) |

## Alert rule (from Jon)

Fire when ANY retailer:
- (a) drops 10%+ below their own historical best, OR
- (b) drops below LUBA.com.au current price (importer floor)

For bundles: subtract included accessories at retail value before comparing.

Ship-to default: Sunshine Coast 4575 QLD.
