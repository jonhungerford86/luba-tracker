// One-shot price snapshot for LUBA 2 AWD 3000X across AU retailers
// Usage: node snapshot-now.mjs

const RETAILERS = [
  { id: 'mammotion-au', name: 'Mammotion AU (Official)', url: 'https://au.mammotion.com', handle: 'luba-2-awd-robot-lawn-mower' },
  { id: 'robot-mowers-au-mower', name: 'Robot Mowers Australia (mower)', url: 'https://robotmowersaustralia.com.au', handle: 'mammotion-luba-2-awd-3000x-3000-order-from-rma' },
  { id: 'robot-mowers-au-garage', name: 'Robot Mowers Australia (Garage Kit bundle)', url: 'https://robotmowersaustralia.com.au', handle: 'mammotion-luba-2-awd-3000x-garage-mow-kit', isBundle: true },
];

// Hit the live storefront variant.js endpoint to get authoritative stock.
// products.json sometimes omits `available`. /products/<handle>/variants/<id>.js returns it.
async function checkVariantStock(storeUrl, handle, variantId) {
  try {
    const r = await fetch(`${storeUrl}/products/${handle}.js`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const data = await r.json();
    const v = (data.variants || []).find(x => String(x.id) === String(variantId));
    if (!v) return null;
    return {
      available: !!v.available,
      inventoryQuantity: v.inventory_quantity ?? null,
      inventoryPolicy: v.inventory_policy ?? null,
      inventoryManagement: v.inventory_management ?? null,
    };
  } catch { return null; }
}

async function fetchProduct(retailer) {
  const url = `${retailer.url}/products/${retailer.handle}.json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) return { ...retailer, error: `HTTP ${r.status}` };
  const data = await r.json();
  const product = data.product;
  if (!product) return { ...retailer, error: 'no product' };

  // Find the 3000X variant. For multi-variant products, match on title containing "3000".
  const variants = product.variants || [];
  const want = variants.find(v => /3000/.test(v.title) || /3000/.test(v.option1 || '') || /3000/.test(v.option2 || ''))
            || variants[0];

  // Get authoritative stock via .js endpoint
  const liveStock = want ? await checkVariantStock(retailer.url, retailer.handle, want.id) : null;

  return {
    ...retailer,
    title: product.title,
    variantTitle: want?.title,
    variantId: want?.id,
    price: want ? parseFloat(want.price) : null,
    compareAt: want?.compare_at_price ? parseFloat(want.compare_at_price) : null,
    available: liveStock?.available ?? null, // null = unknown, true/false = confirmed
    inventoryQuantity: liveStock?.inventoryQuantity,
    inventoryPolicy: liveStock?.inventoryPolicy,
    inventoryManagement: liveStock?.inventoryManagement,
    sku: want?.sku,
    url: `${retailer.url}/products/${retailer.handle}`,
    allVariants: variants.map(v => ({ id: v.id, title: v.title, price: parseFloat(v.price) })),
  };
}

const results = [];
for (const r of RETAILERS) {
  try {
    const data = await fetchProduct(r);
    results.push(data);
  } catch (e) {
    results.push({ ...r, error: e.message });
  }
}

console.log('=== LUBA 2 AWD 3000X — current AU prices ===\n');
for (const r of results) {
  if (r.error) {
    console.log(`  ✗ ${r.name}: ERROR ${r.error}`);
    continue;
  }
  const onSale = r.compareAt && r.compareAt > r.price;
  let stockTag;
  if (r.available === true) stockTag = ' ✓ IN STOCK';
  else if (r.available === false) {
    if (r.inventoryPolicy === 'continue') stockTag = ' ✓ BACKORDER OK';
    else stockTag = ' ✗ OUT OF STOCK';
  }
  else stockTag = ' ? STOCK UNKNOWN';
  const saleTag = onSale ? ` [WAS $${r.compareAt}]` : '';
  const bundleTag = r.isBundle ? ' [BUNDLE]' : '';
  console.log(`  ${r.name}${bundleTag}${stockTag}`);
  console.log(`     Variant: ${r.variantTitle}`);
  console.log(`     Price: $${r.price?.toLocaleString('en-AU')}${saleTag}`);
  if (r.inventoryQuantity != null) console.log(`     Inventory: ${r.inventoryQuantity} units (policy: ${r.inventoryPolicy})`);
  console.log(`     ${r.url}`);
  console.log('');
}

// Summary: cheapest non-bundle
const mowers = results.filter(r => !r.error && !r.isBundle && r.price);
mowers.sort((a, b) => a.price - b.price);
if (mowers.length) {
  const best = mowers[0];
  console.log(`\n💰 Cheapest mower right now: ${best.name} at $${best.price.toLocaleString('en-AU')}`);
}

const bundles = results.filter(r => !r.error && r.isBundle && r.price);
if (bundles.length) {
  console.log('\n📦 Bundles available:');
  bundles.sort((a, b) => a.price - b.price);
  for (const b of bundles) console.log(`   $${b.price.toLocaleString('en-AU')}  ${b.name}`);
}
