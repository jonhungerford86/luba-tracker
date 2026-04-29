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
| Robotic Mowing | Shopify | 🚧 No 3000X listing yet |
| Ople Appliance | Shopify | 🚧 Handle pending |
| LUBA.com.au (importer, **price floor**) | WooCommerce | 🚧 DNS/TLS issue from current host — runs from VM |
| Mammotion DM AU | Custom | 🚧 TLS handshake issue from current host — runs from VM |
| Amazon AU | Marketplace | 🚧 Anti-bot blocked, needs browser/Keepa |
| eBay AU | Marketplace | 🚧 403 anti-bot, needs browser session |

## Pickup checklist

- [x] **Daily cron** — OpenClaw cron `luba-tracker-daily` runs `scripts/daily.ps1` at 06:00 AEST. Failures alert to Telegram "Alerts & System" topic.
- [x] **GitHub repo + Pages** — live at https://jonhungerford86.github.io/luba-tracker/
- [x] **Telegram alerts** — `scripts/check-alerts.mjs` reads bot token from `~/.openclaw/.env`, posts on rule trip with 24h dedup
- [x] **Wayback historical seed** — 6 points seeded for mammotion-au (last 12 months, all $4,199)
- [ ] **Add Ople 3000X handle** once Jon locates the listing on ople.com.au / Kogan / Mattblatt
- [ ] **Move scrapers to integration VM** — LUBA.com.au DNS unresolvable from this Windows machine, mammotiondm.com.au has TLS handshake errors. VM has clean network egress (already runs g1-g5 + shopify-* successfully).
- [ ] **Amazon AU via openclaw browser** — anti-bot blocks plain fetch, needs CDP + cookie session
- [ ] **eBay AU via openclaw browser** — same as Amazon, signed-in session bypasses 403
- [ ] **Wayback seed for Robot Mowers AU** — currently 0 captures, wait for organic indexing or seed via Wayback save-page-now
- [ ] **Historical price chart on dashboard** — sparkline per retailer using the `data/snapshots/` history

## DNS / TLS gotchas (this Windows host)

| Domain | Issue | Workaround |
|---|---|---|
| `luba.com.au` / `www.luba.com.au` | Local DNS returns SERVFAIL even via 8.8.8.8/1.1.1.1 | Run scraper from VM (works there) |
| `www.mammotiondm.com.au` | TLS internal_error from CloudFront edge | Run scraper from VM (works there) |
| Amazon AU | Anti-bot empty results | Use openclaw browser via CDP |
| eBay AU | 403 Forbidden | Use openclaw browser via CDP |

The Shopify retailers (`au.mammotion.com`, `robotmowersaustralia.com.au`) work fine from anywhere because Shopify's storefronts have permissive public APIs and consistent edge config.

## Alert rule (from Jon)

Fire when ANY retailer:
- (a) drops 10%+ below their own historical best, OR
- (b) drops below LUBA.com.au current price (importer floor)

For bundles: subtract included accessories at retail value before comparing.

Ship-to default: Sunshine Coast 4575 QLD.
