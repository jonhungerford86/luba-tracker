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
├── web/                 ← GitHub Pages root
│   ├── index.html       ← dashboard
│   └── data/
│       ├── latest.json  ← what the dashboard reads
│       └── snapshots/   ← one file per run, timestamped
├── scripts/
│   └── snapshot.mjs     ← run once → writes web/data/{latest.json, snapshots/<ts>.json}
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
2. `git add web/data && git commit -m "snapshot $(date)"`
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

- [ ] Add Ople 3000X handle once located
- [ ] Run snapshot from integration VM (luba.com.au + mammotiondm.com.au egress works there)
- [ ] Daily cron + auto-commit on integration VM
- [ ] Wayback Machine historical seed (12 months of price history per retailer)
- [ ] Amazon AU via openclaw browser (CDP) for periodic checks
- [ ] eBay AU via openclaw browser (signed-in session bypasses 403)
- [ ] Telegram alert wiring (compare latest.json to history, fire when rule trips)
- [ ] Historical price chart on dashboard (sparkline per retailer)

## Alert rule (from Jon)

Fire when ANY retailer:
- (a) drops 10%+ below their own historical best, OR
- (b) drops below LUBA.com.au current price (importer floor)

For bundles: subtract included accessories at retail value before comparing.

Ship-to default: Sunshine Coast 4575 QLD.
