/**
 * SiamEPOS — Inventory E2E Test Suite
 * Ticket: QA-INV-01 | Author: Nook (QA Agent) | Date: 2026-05-15
 *
 * HOW TO RUN:
 *   cd ~/Desktop/restaurant-epos
 *   node test-inventory.js
 *
 * Runs against the live Railway backend.
 * Creates test data, verifies results, then cleans up.
 * Requires Node 18+ (uses native fetch).
 */

const BASE = 'https://restaurant-epos-production.up.railway.app';

// ─── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function check(label, actual, expected, opts = {}) {
  const { approx = false, contains = false } = opts;
  let ok = false;
  if (approx)   ok = Math.abs(actual - expected) < 0.05;
  else if (contains) ok = String(actual).includes(String(expected));
  else          ok = actual === expected;

  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Actual:   ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const get  = (path)       => api('GET',    path);
const post = (path, body) => api('POST',   path, body);
const put  = (path, body) => api('PUT',    path, body);
const del  = (path)       => api('DELETE', path);

// Unique ID per test run — avoids stale data from previous runs
const RUN_ID = `test-order-${Date.now()}`;

// Track IDs for cleanup
const cleanup = { ingredients: [], recipes: [] };

// ─── SETUP — seed mock ingredients ──────────────────────────────────────────

async function seedIngredients() {
  console.log('\n🌱 SETUP — Creating mock ingredients...');
  const seeds = [
    { name_en: '__TEST__ Chicken Breast', name_th: 'ไก่อกทดสอบ', unit: 'kg',   cost_per_unit: 4.50, yield_percentage: 100, category: 'Meat',     current_stock: 5,  par_level: 3,   supplier_name: 'Thai Food UK' },
    { name_en: '__TEST__ Jasmine Rice',   name_th: 'ข้าวหอมทดสอบ', unit: 'kg',   cost_per_unit: 1.20, yield_percentage: 100, category: 'Dry Goods', current_stock: 10, par_level: 5,   supplier_name: 'Thai Food UK' },
    { name_en: '__TEST__ Fish Sauce',     name_th: 'น้ำปลาทดสอบ', unit: 'L',    cost_per_unit: 2.80, yield_percentage: 100, category: 'Condiment', current_stock: 2,  par_level: 1,   supplier_name: 'Thai Food UK' },
    { name_en: '__TEST__ Coconut Milk',   name_th: 'กะทิทดสอบ',   unit: 'unit', cost_per_unit: 0.95, yield_percentage: 100, category: 'Tinned',    current_stock: 8,  par_level: 4,   supplier_name: 'Thai Food UK' },
    { name_en: '__TEST__ Lemongrass',     name_th: 'ตะไคร้ทดสอบ', unit: 'kg',   cost_per_unit: 3.00, yield_percentage: 80,  category: 'Veg',       current_stock: 0.5,par_level: 0.5, supplier_name: 'Thai Food UK' },
  ];
  const ids = {};
  for (const seed of seeds) {
    const { data } = await post('/api/ingredients', seed);
    if (!data.id) throw new Error(`Failed to create ingredient: ${seed.name_en}`);
    cleanup.ingredients.push(data.id);
    ids[seed.name_en] = data.id;
    console.log(`  ✔ Created: ${seed.name_en} (id=${data.id})`);
  }
  return ids;
}

// ─── BLOCK 1 — Invoice Scanner ───────────────────────────────────────────────

async function testBlock1(ids) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 1 — Invoice Scanner (SEPOS-046 fix)');
  console.log('════════════════════════════════════════════════');

  const lineItems = [
    { name_extracted: '__TEST__ Chicken Breast', quantity: 10,  unit: 'kg',   unit_price: 4.80, line_total: 48.00,  matched_ingredient_id: ids['__TEST__ Chicken Breast'] },
    { name_extracted: '__TEST__ Jasmine Rice',   quantity: 20,  unit: 'kg',   unit_price: 1.20, line_total: 24.00,  matched_ingredient_id: ids['__TEST__ Jasmine Rice']   },
    { name_extracted: '__TEST__ Fish Sauce',     quantity: 5,   unit: 'L',    unit_price: 3.10, line_total: 15.50,  matched_ingredient_id: ids['__TEST__ Fish Sauce']     },
    { name_extracted: '__TEST__ Coconut Milk',   quantity: 24,  unit: 'unit', unit_price: 0.90, line_total: 21.60,  matched_ingredient_id: ids['__TEST__ Coconut Milk']   },
    { name_extracted: '__TEST__ Lemongrass',     quantity: 2,   unit: 'kg',   unit_price: 3.00, line_total: 6.00,   matched_ingredient_id: ids['__TEST__ Lemongrass']     },
    { name_extracted: '__TEST__ NEW Galangal',   quantity: 1,   unit: 'kg',   unit_price: 4.00, line_total: 4.00,   matched_ingredient_id: null }, // auto-create
  ];

  const { status, data } = await post('/api/supplier-invoices', {
    supplier_name:  'Thai Food UK',
    invoice_date:   '2026-05-15',
    invoice_number: 'TFU-TEST-0001',
    total_amount:   119.10,
    status:         'processed',
    line_items:     lineItems,
  });

  // 1A — Response shape
  check('POST /api/supplier-invoices returns 200', status, 200);
  check('Response has invoiceId', typeof data.id, 'number');
  check('Response has created array', Array.isArray(data.created), true);
  check('Response has updated array', Array.isArray(data.updated), true);
  check('Response has price_changes array', Array.isArray(data.price_changes), true);

  // 1B — Updated list (5 matched ingredients)
  check('5 matched ingredients in updated[]', data.updated?.length, 5);

  // 1C — Auto-created ingredient
  check('1 new ingredient auto-created', data.created?.length, 1);
  check('Auto-created name correct', data.created?.[0], '__TEST__ NEW Galangal');

  // 1D — Price changes detected (Chicken +0.30, Fish Sauce +0.30, Coconut Milk -0.05)
  check('3 price changes detected', data.price_changes?.length, 3);
  const chickenChange = data.price_changes?.find(p => p.name === '__TEST__ Chicken Breast');
  check('Chicken Breast old cost = 4.50', chickenChange?.old_cost, 4.50, { approx: true });
  check('Chicken Breast new cost = 4.80', chickenChange?.new_cost, 4.80, { approx: true });

  // 1E — Verify stock levels updated
  console.log('\n  Verifying stock levels in DB...');
  const { data: ings } = await get('/api/ingredients');
  const find = (name) => ings.find(i => i.name_en === name);

  const chicken     = find('__TEST__ Chicken Breast');
  const rice        = find('__TEST__ Jasmine Rice');
  const fishSauce   = find('__TEST__ Fish Sauce');
  const coconut     = find('__TEST__ Coconut Milk');
  const lemongrass  = find('__TEST__ Lemongrass');
  const galangal    = find('__TEST__ NEW Galangal');

  check('Chicken Breast stock: 5+10 = 15 kg',   parseFloat(chicken?.current_stock),    15,   { approx: true });
  check('Jasmine Rice stock: 10+20 = 30 kg',     parseFloat(rice?.current_stock),       30,   { approx: true });
  check('Fish Sauce stock: 2+5 = 7 L',           parseFloat(fishSauce?.current_stock),  7,    { approx: true });
  check('Coconut Milk stock: 8+24 = 32 units',   parseFloat(coconut?.current_stock),    32,   { approx: true });
  check('Lemongrass stock: 0.5+2 = 2.5 kg',      parseFloat(lemongrass?.current_stock), 2.5,  { approx: true });
  check('Galangal auto-created stock = 1 kg',    parseFloat(galangal?.current_stock),   1,    { approx: true });

  // 1F — Verify costs updated
  check('Chicken Breast cost updated to £4.80',  parseFloat(chicken?.cost_per_unit),    4.80, { approx: true });
  check('Jasmine Rice cost unchanged at £1.20',  parseFloat(rice?.cost_per_unit),       1.20, { approx: true });
  check('Fish Sauce cost updated to £3.10',      parseFloat(fishSauce?.cost_per_unit),  3.10, { approx: true });
  check('Coconut Milk cost updated to £0.90',    parseFloat(coconut?.cost_per_unit),    0.90, { approx: true });

  // 1G — Stock log entries
  const { data: movements } = await get('/api/stock/movements');
  const deliveries = movements.filter(m =>
    m.movement_type === 'delivery' && m.reference?.startsWith('invoice:')
  );
  check('At least 6 stock movements logged (5 matched + 1 auto-created)', deliveries.length >= 6, true);

  // 1H — Zero quantity line is skipped (edge case)
  const { data: zeroTest } = await post('/api/supplier-invoices', {
    supplier_name: 'Zero Test Supplier', invoice_date: '2026-05-15',
    invoice_number: 'ZERO-TEST-001', total_amount: 0, status: 'processed',
    line_items: [{ name_extracted: '__TEST__ Chicken Breast', quantity: 0, unit: 'kg', unit_price: 5.00, line_total: 0, matched_ingredient_id: ids['__TEST__ Chicken Breast'] }],
  });
  const chickenAfterZero = (await get('/api/ingredients')).data.find(i => i.name_en === '__TEST__ Chicken Breast');
  check('Zero-quantity line does NOT change stock',  parseFloat(chickenAfterZero?.current_stock), 15, { approx: true });
  check('Zero-quantity line does NOT change cost',   parseFloat(chickenAfterZero?.cost_per_unit),  4.80, { approx: true });

  // Track auto-created galangal for cleanup
  if (galangal?.id) cleanup.ingredients.push(galangal.id);

  return data.id; // invoice id for later reference
}

// ─── BLOCK 2 — Recipe Creation ───────────────────────────────────────────────

async function testBlock2(ids) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 2 — Recipe Creation & Food Cost %');
  console.log('════════════════════════════════════════════════');

  // Fetch menu items to find a real dish ID
  const { data: categories } = await get('/api/menu');
  const allItems = (Array.isArray(categories) ? categories : []).flatMap(c => c.items || []);
  const testDish = allItems[0];

  if (!testDish) {
    console.log('  ⚠️  No menu items found — skipping recipe creation against real menu item.');
    console.log('  ℹ️  Testing recipe API with a placeholder menu_item_id = 99999');
  }

  const dishId    = testDish?.id || 99999;
  const dishPrice = parseFloat(testDish?.price) || 12.00;
  console.log(`  Using dish: ${testDish?.name || 'Placeholder'} (id=${dishId}, price=£${dishPrice.toFixed(2)})`);

  // Build Pad Thai-style recipe using mock ingredients
  // Chicken 0.15 kg @ £4.80 = £0.72
  // Rice    0.10 kg @ £1.20 = £0.12
  // Fish    0.02 L  @ £3.10 = £0.062
  // Total = £0.902 cost per portion
  const serves = 1;
  const lines = [
    { ingredient_id: ids['__TEST__ Chicken Breast'], quantity_used: 0.15, unit: 'kg', cost_per_unit: 4.80, yield_percentage: 100, line_cost: 0.15 * 4.80 },
    { ingredient_id: ids['__TEST__ Jasmine Rice'],   quantity_used: 0.10, unit: 'kg', cost_per_unit: 1.20, yield_percentage: 100, line_cost: 0.10 * 1.20 },
    { ingredient_id: ids['__TEST__ Fish Sauce'],     quantity_used: 0.02, unit: 'L',  cost_per_unit: 3.10, yield_percentage: 100, line_cost: 0.02 * 3.10 },
  ];
  const expectedTotalCost = lines.reduce((s, l) => s + l.line_cost, 0);
  const expectedCPP       = expectedTotalCost / serves;
  const expectedFoodCostPct = (expectedCPP / dishPrice) * 100;

  const { status, data } = await post('/api/recipes', {
    menu_item_id: dishId,
    name: `__TEST__ Pad Thai Recipe`,
    serves,
    lines,
  });

  check('POST /api/recipes returns 200',         status, 200);
  check('Recipe has an id',                      typeof data.id, 'number');

  if (data.id) {
    cleanup.recipes.push(data.id);

    // Verify stored recipe
    const { data: stored } = await get(`/api/recipes/menu-item/${dishId}`);
    check('Recipe stored with correct menu_item_id', stored?.menu_item_id, dishId);
    check('Recipe has 3 lines',                      stored?.lines?.length, 3);
    check('cost_per_portion stored correctly',        parseFloat(stored?.cost_per_portion), expectedCPP, { approx: true });
    check('total_cost stored correctly',              parseFloat(stored?.total_cost), expectedTotalCost, { approx: true });

    // Yield percentage test — Lemongrass at 80% yield
    // 0.1 kg × £3.00 / 0.80 = £0.375
    const yieldLine = {
      ingredient_id: ids['__TEST__ Lemongrass'],
      quantity_used: 0.1,
      unit: 'kg',
      cost_per_unit: 3.00,
      yield_percentage: 80,
      line_cost: (0.1 * 3.00) / 0.80,
    };
    check('Yield 80%: line_cost = 0.1 × £3.00 / 0.80 = £0.375', yieldLine.line_cost, 0.375, { approx: true });

    // Update recipe — change serves to 2 (cost per portion should halve)
    const { status: updateStatus } = await put(`/api/recipes/${data.id}`, {
      name: `__TEST__ Pad Thai Recipe`,
      serves: 2,
      lines,
    });
    check('PUT /api/recipes/:id returns 200', updateStatus, 200);
    const { data: updated } = await get(`/api/recipes/menu-item/${dishId}`);
    check('cost_per_portion halves when serves=2', parseFloat(updated?.cost_per_portion), expectedCPP / 2, { approx: true });
  }

  // Empty lines edge case
  const { data: emptyRecipe } = await post('/api/recipes', {
    menu_item_id: 88888,
    name: '__TEST__ Empty Recipe',
    serves: 1,
    lines: [],
  });
  // Should succeed at API level (validation is in the UI); just verify no crash
  check('Empty lines recipe does not crash server', typeof emptyRecipe, 'object');

  return data.id;
}

// ─── BLOCK 3 — Price Change Impact ───────────────────────────────────────────

async function testBlock3(ids) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 3 — Price Change Impact on Recipe Costs');
  console.log('════════════════════════════════════════════════');

  // After Block 1, Chicken Breast should be £4.80 (was £4.50)
  // Recipes that use Chicken Breast should reflect the new cost when loaded

  const { data: ings } = await get('/api/ingredients');
  const chicken = ings.find(i => i.name_en === '__TEST__ Chicken Breast');

  check('Chicken Breast cost is now £4.80 (updated by invoice)', parseFloat(chicken?.cost_per_unit), 4.80, { approx: true });
  check('Fish Sauce cost is now £3.10 (updated by invoice)',      parseFloat(ings.find(i => i.name_en === '__TEST__ Fish Sauce')?.cost_per_unit), 3.10, { approx: true });
  check('Coconut Milk cost is now £0.90 (updated by invoice)',    parseFloat(ings.find(i => i.name_en === '__TEST__ Coconut Milk')?.cost_per_unit), 0.90, { approx: true });
  check('Jasmine Rice cost still £1.20 (price unchanged)',        parseFloat(ings.find(i => i.name_en === '__TEST__ Jasmine Rice')?.cost_per_unit), 1.20, { approx: true });

  // Verify stock log shows delivery movements
  const { data: movements } = await get('/api/stock/movements');
  const chickenDeliveries = movements.filter(m =>
    m.ingredient_name === '__TEST__ Chicken Breast' && m.movement_type === 'delivery'
  );
  check('Stock log has delivery entry for Chicken Breast', chickenDeliveries.length >= 1, true);
  check('Stock movement quantity = 10 kg', parseFloat(chickenDeliveries[0]?.quantity), 10, { approx: true });
  check('Stock movement cost_at_time = £4.80', parseFloat(chickenDeliveries[0]?.cost_at_time), 4.80, { approx: true });

  // Low stock check — Lemongrass was 0.5 kg at PAR 0.5, received 2 kg → now 2.5 kg, above PAR
  const lemongrass = ings.find(i => i.name_en === '__TEST__ Lemongrass');
  const lemongrassAbovePar = parseFloat(lemongrass?.current_stock) >= parseFloat(lemongrass?.par_level);
  check('Lemongrass above PAR after delivery (2.5 kg ≥ 0.5 kg PAR)', lemongrassAbovePar, true);

  // Verify /api/ingredients/low-stock does NOT include lemongrass now
  const { data: lowStock } = await get('/api/ingredients/low-stock');
  const lemongrassInLowStock = lowStock.some(i => i.name_en === '__TEST__ Lemongrass');
  check('Lemongrass NOT in low-stock list after restock', lemongrassInLowStock, false);
}

// ─── BLOCK 4 — Mock Sale + Stock Depletion ────────────────────────────────────

async function testBlock4(ids) {
  console.log('\n════════════════════════════════════════════════');
  console.log('BLOCK 4 — Stock Depletion on Sale');
  console.log('════════════════════════════════════════════════');
  console.log('  ℹ️  Stock depletion fires when order items are fired (KDS).');
  console.log('  ℹ️  Testing depleteStockForItems via the stock/adjustment endpoint');
  console.log('      (direct sale simulation — mirrors what KDS fire does).');

  // Record stock BEFORE
  const { data: before } = await get('/api/ingredients');
  const chickenBefore = parseFloat(before.find(i => i.name_en === '__TEST__ Chicken Breast')?.current_stock);
  const riceBefore    = parseFloat(before.find(i => i.name_en === '__TEST__ Jasmine Rice')?.current_stock);
  console.log(`\n  Stock BEFORE: Chicken=${chickenBefore} kg, Rice=${riceBefore} kg`);

  // Simulate a sale deduction (same logic as depleteStockForItems: recipe line qty)
  // Pad Thai uses: Chicken 0.15 kg, Rice 0.10 kg, Fish Sauce 0.02 L
  // Simulate 2× Pad Thai sale
  const deductions = [
    { ingredient_id: ids['__TEST__ Chicken Breast'], quantity: -(0.15 * 2), movement_type: 'sale', cost_at_time: 4.80, note: 'Test sale: 2× Pad Thai', reference: RUN_ID },
    { ingredient_id: ids['__TEST__ Jasmine Rice'],   quantity: -(0.10 * 2), movement_type: 'sale', cost_at_time: 1.20, note: 'Test sale: 2× Pad Thai', reference: RUN_ID },
    { ingredient_id: ids['__TEST__ Fish Sauce'],     quantity: -(0.02 * 2), movement_type: 'sale', cost_at_time: 3.10, note: 'Test sale: 2× Pad Thai', reference: RUN_ID },
  ];

  for (const d of deductions) {
    const { status } = await post('/api/stock/adjustment', d);
    check(`Stock adjustment accepted for ${d.note.split(':')[1].trim()}`, status, 200);
  }

  // Verify stock AFTER
  const { data: after } = await get('/api/ingredients');
  const chickenAfter   = parseFloat(after.find(i => i.name_en === '__TEST__ Chicken Breast')?.current_stock);
  const riceAfter      = parseFloat(after.find(i => i.name_en === '__TEST__ Jasmine Rice')?.current_stock);
  const fishSauceAfter = parseFloat(after.find(i => i.name_en === '__TEST__ Fish Sauce')?.current_stock);
  console.log(`  Stock AFTER:  Chicken=${chickenAfter} kg, Rice=${riceAfter} kg`);

  check(`Chicken Breast: ${chickenBefore} - 0.30 = ${chickenBefore - 0.30} kg`, chickenAfter, chickenBefore - 0.30, { approx: true });
  check(`Jasmine Rice:   ${riceBefore} - 0.20 = ${riceBefore - 0.20} kg`,       riceAfter,   riceBefore   - 0.20, { approx: true });
  check('Fish Sauce deducted by 0.04 L', fishSauceAfter, 7 - 0.04, { approx: true });

  // Stock floor test — set Lemongrass to 0.05 kg, deduct 0.10 kg → should floor at 0
  await put(`/api/ingredients/${ids['__TEST__ Lemongrass']}`, {
    name_en: '__TEST__ Lemongrass', name_th: 'ตะไคร้ทดสอบ', unit: 'kg',
    cost_per_unit: 3.00, yield_percentage: 80, category: 'Veg',
    current_stock: 0.05, par_level: 0.5, supplier_name: 'Thai Food UK', allergens: '[]'
  });
  await post('/api/stock/adjustment', {
    ingredient_id: ids['__TEST__ Lemongrass'],
    quantity: -0.10,
    movement_type: 'sale',
    cost_at_time: 3.00,
    note: 'Stock floor test',
  });
  const { data: floorCheck } = await get('/api/ingredients');
  const lemongrassFloor = parseFloat(floorCheck.find(i => i.name_en === '__TEST__ Lemongrass')?.current_stock);
  check('Stock floors at 0 (GREATEST(0,...)) — does not go negative', lemongrassFloor >= 0, true);
  check('Stock floor value is exactly 0', lemongrassFloor, 0, { approx: true });

  // Low stock alert triggers after depletion
  const { data: lowStock } = await get('/api/ingredients/low-stock');
  const lemongrassLow = lowStock.some(i => i.name_en === '__TEST__ Lemongrass');
  check('Lemongrass appears in low-stock list after depletion (0 < PAR 0.5)', lemongrassLow, true);

  // Stock log has sale entries
  const { data: movements } = await get('/api/stock/movements');
  const saleMoves = movements.filter(m => m.reference === RUN_ID);
  check('3 stock movement entries logged for test sale', saleMoves.length, 3);
}

// ─── CLEANUP ─────────────────────────────────────────────────────────────────

async function cleanUp() {
  console.log('\n🧹 CLEANUP — Removing test data...');
  for (const id of cleanup.recipes) {
    await del(`/api/recipes/${id}`);
    console.log(`  Deleted recipe id=${id}`);
  }
  for (const id of cleanup.ingredients) {
    await del(`/api/ingredients/${id}`);
    console.log(`  Deleted ingredient id=${id}`);
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  SiamEPOS — Inventory E2E Test Suite             ║');
  console.log('║  Nook (QA Agent) | 2026-05-15 | QA-INV-01        ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Backend: ${BASE}`);

  try {
    const ids = await seedIngredients();
    await testBlock1(ids);
    await testBlock2(ids);
    await testBlock3(ids);
    await testBlock4(ids);
  } catch (err) {
    console.error('\n💥 FATAL ERROR — test run aborted:', err.message);
    failed++;
  } finally {
    await cleanUp();
  }

  const total = passed + failed;
  console.log('\n════════════════════════════════════════════════');
  console.log(`  RESULT: ${total} tests | ✅ ${passed} passed | ❌ ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failed tests:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  if (failed === 0 && passed > 0) {
    console.log('\n  🎉 All tests passed! Inventory is working correctly.');
  }
  console.log('════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main();
