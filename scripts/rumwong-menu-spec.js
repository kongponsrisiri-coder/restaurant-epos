// Rumwong Thai Restaurant — till menu spec (16 Sep 2026)
// Rule from Korakot: EVERY item carries its menu number; descriptions dropped.
// Food numbers = their printed à la carte (1–93 + 711/722/12A); veg menu has no
// printed numbers → V1…; set menus → S1/S2; cocktails → C1…; irresistible → D1….
// Variant prices ("clear 10.65 · creamy 10.95") = required single-choice modifier
// group, base price = cheapest option, deltas on the others.
const fs = require('fs');
const { ALC, VEG } = JSON.parse(fs.readFileSync(__dirname + '/rumwong-food.json', 'utf8'));

const money = (s) => Number(String(s).replace(/[^\d.]/g, ''));

// Parse "beef 9.45 · chicken 9.45" → [{label, price}]; plain "13.95" → null.
function variants(priceStr) {
  if (!/·/.test(priceStr)) return null;
  return priceStr.split('·').map((p) => {
    const m = p.trim().match(/^(.*?)\s*([\d.]+)$/);
    return { label: (m[1] || '').trim() || 'Standard', price: money(m[2]) };
  });
}

function itemFrom(number, name, priceStr, markers, groupName) {
  const v = variants(priceStr);
  const perPerson = /per person/i.test(priceStr);
  const allergens = /n/.test(markers || '') ? ['Nuts'] : null;
  const it = { name: `${number}. ${name}${perPerson ? ' (per person)' : ''}`, allergens, modifiers: [] };
  if (v) {
    // "chicken, pork or beef" → separate options at the same price
    const opts = [];
    for (const o of v) {
      const parts = o.label.split(/,| or /).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) opts.push({ name: p.charAt(0).toUpperCase() + p.slice(1), price: o.price });
    }
    const base = Math.min(...opts.map((o) => o.price));
    it.price = base;
    it.modifiers.push({ name: groupName || 'Choice', required: true, multi_select: false,
      options: opts.map((o) => ({ name: o.name, extra_price: +(o.price - base).toFixed(2) })) });
  } else {
    it.price = money(priceStr);
  }
  return it;
}

const CATS = [];
// ── Food (à la carte) ─────────────────────────────────────────────────────
const COURSE = { "Hors d'Oeuvre": 1, Soups: 1, Salads: 1, Curries: 2, Chicken: 2, Pork: 2, Beef: 2, Prawns: 2, Fish: 2, Seafood: 2, Duck: 2, 'Side Dishes': 2, 'One-plate dishes “Jarn Diew”': 2, 'Rice & Noodles': 2 };
const RENAME = { 'One-plate dishes “Jarn Diew”': 'One-Plate Dishes (Jarn Diew)' };
for (const c of ALC) {
  const items = [];
  for (const [num, name, _desc, price, markers] of c.items) {
    const number = num || '13';   // printed menu skips 13 between 12A and 14 — the sharing starter
    items.push(itemFrom(number, name, price, markers));
  }
  CATS.push({ name: RENAME[c.cat] || c.cat, course: COURSE[c.cat] || 2, is_bar: 0, items });
}
// ── Vegetarian & Vegan menu (V-numbers, ours) ─────────────────────────────
let vn = 0;
const vegItems = [];
for (const c of VEG) for (const [name, _d, price, tag] of c.items) {
  vn += 1;
  const it = itemFrom(`V${vn}`, name, price.replace(/^([\d.]+) · with (tofu|eggs) ([\d.]+)$/, 'plain $1 · with $2 $3'), '', 'Option');
  if (tag === 'vg') it.name += ' (vegan)';
  vegItems.push(it);
}
CATS.push({ name: 'Vegetarian & Vegan', course: 2, is_bar: 0, items: vegItems });
// ── Set menus ──────────────────────────────────────────────────────────────
CATS.push({ name: 'Set Menus', course: 2, is_bar: 0, items: [
  { name: 'S1. Alangkarn Banquet (per person)', price: 37.95, allergens: null, modifiers: [] },
  { name: 'S2. Lakorn Pre-Theatre 2 Courses (per person)', price: 22.95, allergens: null, modifiers: [
    { name: 'Main supplement', required: false, multi_select: false, options: [ { name: 'Duck', extra_price: 1.50 }, { name: 'Prawns', extra_price: 2.00 }, { name: 'Fried egg', extra_price: 1.95 } ] } ] },
] });

// ── Drinks (from the 11 menu photos, 15 Sep 2026) ─────────────────────────
const d = (name, price, mods) => ({ name, price, allergens: null, modifiers: mods || [] });
const choice = (name, opts) => ({ name, required: true, multi_select: false, options: opts.map((o) => typeof o === 'string' ? { name: o, extra_price: 0 } : o) });
const glass = (n, name, bottle, sizes) => {
  // Bottle as the base; by-the-glass as separate numbered items so bar tickets + reports read cleanly
  const out = [d(`${n}. ${name} — Bottle`, bottle)];
  for (const [ml, p] of sizes) out.push(d(`${n}. ${name} — ${ml}`, p));
  return out;
};
const wineSizes = (a, b, c) => [['125ml', a], ['175ml', b], ['250ml', c]];

CATS.push({ name: 'House & Rosé Wines', course: 4, is_bar: 1, items: [
  ...glass('1', 'Bergerie de la Bastide Blanc', 25.95, wineSizes(5.35, 7.45, 10.15)),
  ...glass('2', 'Bergerie de la Bastide Rouge', 25.95, wineSizes(5.35, 7.45, 10.15)),
  ...glass('3', 'Henri Nordoc Cinsault Rosé', 28.45, wineSizes(5.90, 8.05, 11.35)),
] });
CATS.push({ name: 'Champagne & Sparkling', course: 4, is_bar: 1, items: [
  ...glass('4', 'Prosecco Biologico Spumante Bernardi', 44.85, [['125ml', 9.40]]),
  d('5. Champagne Carte Noire Brut J.P. Deville NV', 61.95),
  d('6. Veuve Clicquot Champagne Brut NV', 95.95),
] });
CATS.push({ name: 'Beer', course: 4, is_bar: 1, items: [
  d('7. Peroni 330ml', 5.25), d('7a. Lager Shandy 330ml', 4.95), d('7b. Lucky Saint Non-Alcohol Beer 330ml', 4.95),
  d('8. Singha Thai Beer 330ml', 5.50), d('8a. Singha Draft Half Pint', 4.75), d('8b. Singha Draft Pint', 7.95),
  d('8c. Singha Draft Tower 3 litre', 39.95), d('8d. Singha Soju Bomb 1 pint', 9.95),
] });
CATS.push({ name: 'Wine Cocktails', course: 4, is_bar: 1, items: [
  d('9a. Kir Royale 125ml', 8.95), d('10a. Kir 125ml', 5.95),
] });
CATS.push({ name: 'White Wines', course: 4, is_bar: 1, items: [
  d('9. Colombard/Sauvignon, Côtes de Gascogne, Menard', 29.95),
  ...glass('11', 'Sauvignon Blanc, Valle Maule, Naciente', 28.95, [['175ml', 8.25]]),
  ...glass('12', 'Chardonnay, Colchagua, Naciente', 32.95, [['175ml', 9.40]]),
  ...glass('13', 'Pinot Grigio, Trefili Cantina San Marziano', 30.95, [['175ml', 8.80]]),
  d('14. Chenin Blanc (Bush Vine), Good Hope', 31.95),
  d('15. Picpoul de Pinet, Grange des Rocs', 34.00),
  d('16. Samurai Chardonnay, South Eastern Australia', 32.25),
  d('17. Te Whare Ra Sauvignon Blanc, Marlborough', 48.25),
  d('18. Petit Chablis Gerard Tremblay', 52.95),
  d('19. Sancerre "La Vigne Blanche" Henri Bourgeois', 60.95),
] });
CATS.push({ name: 'Red Wines', course: 4, is_bar: 1, items: [
  d("21. Cabernet Sauvignon Domaine Nordoc VDP d'Oc", 29.95),
  ...glass('22', 'Malbec Organica Santa Julia, Mendoza', 33.45, [['175ml', 9.50]]),
  ...glass('23', 'Merlot Metic, Colchagua Valley', 29.95, [['175ml', 8.65]]),
  d('24. Tempranillo Albizu, Vina Albergada, Rioja', 26.45),
  d('25. Montepulciano d\'Abruzzo "Frentano"', 30.95),
  d('26. Bordeaux Rouge Chateau Deville', 40.25),
  d('27. Shiraz/Malbec, Villa Vieja', 29.95),
  d('28. Moulin de Gassac Pinot Noir', 36.95),
  d('29. Rioja Crianza Bodegas Urbina, Rioja Alta', 45.95),
  d('31. Chateau La Claymore Lussac Saint-Emilion', 57.45),
] });
CATS.push({ name: 'Sherry, Port & Vermouth', course: 4, is_bar: 1, items: [
  d('54. Harveys Bristol Cream 50ml', 5.50), d('55. Harveys Amontillado 50ml', 5.50),
  d('56. Cockburns Fine Ruby 50ml', 5.50), d('57. Cockburns Fine Tawny 50ml', 5.50), d('58. Cockburns Special Reserve 50ml', 6.10),
  d('59. Cinzano Bianco 50ml', 5.50), d('60. Martini Rosso 50ml', 5.50), d('61. Martini Extra Dry 50ml', 5.50),
] });
CATS.push({ name: 'Aperitifs & Spirits', course: 4, is_bar: 1, items: [
  d('62. Campari 25ml', 5.50), d('63. Archers 25ml', 5.50), d("64. Pimm's 25ml", 5.50),
  d('65. Grants Standfast 25ml', 5.50), d('66. Teachers 25ml', 5.50), d('67. Jack Daniels 25ml', 5.50),
  d('68. Bells Extra Special 25ml', 5.50), d('72. Jim Beam Bourbon 25ml', 5.50), d('72a. Jameson Irish 25ml', 5.50),
  d('69. Johnnie Walker Black Label 25ml', 5.90), d('70. Glenfiddich Single Malt 25ml', 7.45),
  d('71. Glenmorangie Single Malt 25ml', 7.90), d('71a. Smiths "The Glenlivet" Single Malt 25ml', 7.45),
  d('73. Gordons London Dry 25ml', 5.50), d('74. Pink Gin 25ml', 5.50), d('74a. Bombay Sapphire 25ml', 5.65),
  d('75. Captain Morgan 25ml', 5.50), d('76. Bacardi Carta Blanca 25ml', 5.50),
  d('77. Smirnoff 25ml', 5.50), d('77a. Aperitif Mix (Single)', 6.85), d('77b. Aperitif Mix (Double)', 11.30),
  d('79. Hennessy 25ml', 7.45), d('80. Courvoisier VSOP 25ml', 7.10), d('81. Remy Martin VSOP 25ml', 7.90),
] });
CATS.push({ name: 'Liqueurs', course: 4, is_bar: 1, items: [
  d('86. Benedictine DOM 25ml', 5.90), d('87. Grand Marnier 25ml', 5.90), d('88. Southern Comfort 25ml', 5.50),
  d('89. Galliano 25ml', 5.90), d('90. Cointreau 25ml', 5.50), d('91. Malibu 25ml', 5.50), d('92. Drambuie 25ml', 5.90),
  d('93. Tia Maria 25ml', 5.50), d('94. Disaronno Amaretto 25ml', 5.50), d('95. Kahlua 25ml', 5.50), d('96. Tequila 25ml', 5.50),
  d('97. Sambuca 25ml', 5.50), d('98. Lychee Liqueur 25ml', 5.90), d("113. Bailey's Irish Cream 25ml", 5.50),
  d('114. Cherry Brandy 25ml', 5.50), d('115. Thai Rum Mekhong 25ml', 5.50),
] });
CATS.push({ name: 'Soft Drinks & Juices', course: 4, is_bar: 1, items: [
  d('82. Pure Orange Juice', 4.20), d('83. Pineapple Juice', 3.85), d('84. Tomato Juice', 3.85), d('85. Apple Juice', 3.85), d('85a. Cranberry Juice', 3.85),
  d('99. Bitter Lemon', 3.35), d('100. Tonic Water', 3.35), d('101. Dry Ginger Ale', 3.35), d('102. Slimline Tonic', 3.35), d('103. Soda Water', 3.35),
  d('104. Sprite Zero Sugar (bottle)', 3.95), d('104a. Appletiser (bottle)', 3.95),
  d('105. Coca Cola / Diet Coke / Coke Zero (bottle)', 3.95, [choice('Which', ['Coca Cola', 'Diet Coke', 'Coke Zero'])]),
  d('105a. Mix Soft Drinks', 4.95),
  d('111. Mineral Water 75cl (bottle)', 6.95, [choice('Still or sparkling', ['Still', 'Sparkling'])]),
  d('111a. Mineral Water by the Glass', 2.95),
] });
CATS.push({ name: 'Coffee & Tea', course: 4, is_bar: 1, items: [
  d('106. Iced Thai Tea / Green Tea / Coffee with Milk', 6.50, [choice('Which', ['Iced Thai Tea', 'Iced Green Tea', 'Iced Coffee'])]),
  d('107. Iced Thai Tea with Lemon', 6.20),
  d('108. Coffee / Decaff Coffee / English Tea', 3.30, [choice('Which', ['Coffee', 'Decaff Coffee', 'English Tea'])]),
  d('109. Irish / Calypso / French Coffee (liqueur)', 8.95, [choice('Which', ['Irish Coffee', 'Calypso Coffee', 'French Coffee'])]),
  d('110. Jasmine Tea / Green Tea', 2.95, [choice('Which', ['Jasmine Tea', 'Green Tea'])]),
  d('116. Lemongrass Tea', 2.95), d('117. Peppermint Tea', 2.95), d('118. Chrysanthemum Tea', 2.95),
  d('307. Cafe Latte', 4.30), d('308. Cappuccino', 4.30),
  d('309. Espresso / Double Espresso', 3.45, [choice('Size', [{ name: 'Single', extra_price: 0 }, { name: 'Double', extra_price: 1.00 }])]),
  d('310. Hot Chocolate', 4.30), d('311. Special Flowering Tea (per pot)', 6.95),
] });
CATS.push({ name: 'Cocktails', course: 4, is_bar: 1, items: [
  d('C1. Be My Soju — Sharing Bucket', 18.00), d('C2. Raspberry Pornstar', 13.00), d('C3. Mao Mao Pirinha', 13.00),
  d('C4. Phuket Fantasy', 13.00), d('C5. Thai Passion', 13.00), d('C6. Bangkok Mai Tai', 13.00), d('C7. Bird of Paradise', 12.00),
  d('C8. Soju Bomb', 11.00), d('C9. Dragon Island', 13.00), d('C10. Strawberry & Lychee Daiquiri', 12.00),
  d('C11. Long Island Ice Tea', 13.00), d('C12. Pina Colada', 12.00), d('C13. Mojito', 11.00), d('C14. Margarita', 11.00),
  d("C15. Pimm's", 11.00), d('C16. Virgin Mai Tai', 9.00), d('C17. Virgin Phuket Fantasy', 9.00), d('C18. Virgin Blueberry Burst', 9.50),
  d('C19. Espresso Martini', 11.00), d('C20. Affogato Martini', 14.00),
] });
const milk = () => [choice('Milk', [{ name: 'Without milk', extra_price: 0 }, { name: 'With milk', extra_price: 0.50 }])];
CATS.push({ name: 'Irresistible Drinks', course: 4, is_bar: 1, items: [
  d('D1. Passion Fruit Cooler', 9.50), d('D2. Lychee Jelly Crush', 9.50),
  d('D3. Thai Iced Tea', 6.00, milk()), d('D4. Thai Iced Coffee', 6.00, milk()), d('D5. Iced Green Tea', 6.00, milk()),
  d('D6. Thai Iced Lemon Tea', 6.20),
  d('D7. Very Berry Smoothie', 7.50), d('D8. Berrylicious Banana Smoothie', 7.50), d('D9. Bangkok Sunrise (Watermelon Smoothie)', 7.50),
  d('D10. Tropical Sunrise (Mango & Pineapple Smoothie)', 7.50), d('D11. Lychee Cloud Smoothie', 7.50),
  d('D12. Oreo Blizzard', 8.00), d('D13. Swiss Chocolate', 8.00), d('D14. Coconut Dream', 8.00),
  d('D15. Classic Coffee Frappe', 9.00), d('D16. Caramel Coffee Frappe', 9.00),
] });

module.exports = { CATS };
if (require.main === module) {
  let n = 0, m = 0;
  for (const c of CATS) { n += c.items.length; m += c.items.filter((i) => i.modifiers.length).length; }
  console.log(`${CATS.length} categories, ${n} items, ${m} with modifier groups`);
  for (const c of CATS) console.log(`  ${c.is_bar ? '🍸' : '🍽️'} ${c.name}: ${c.items.length}`);
  const bad = CATS.flatMap((c) => c.items).filter((i) => !(i.price > 0) || !/^[A-Z]?\d+[a-zA-Z]?\. /.test(i.name));
  if (bad.length) { console.log('CHECK:', bad.map((b) => b.name + ' ' + b.price)); process.exit(1); }
  console.log('every item numbered + priced ✓');
}
